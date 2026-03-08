import {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
    NodeOperationError,
    IHttpRequestMethods,
} from 'n8n-workflow';

// ----------------------------------------------------------------
// Exponential Backoff Retry Wrapper
// ----------------------------------------------------------------
async function httpRequestWithRetry(
    context: IExecuteFunctions,
    options: any,
    maxRetries = 3,
    baseDelay = 1000,
): Promise<any> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await context.helpers.httpRequest(options);

        // If the response is a non-retryable error (client error), return immediately
        if (response.error) {
            const code = response.error.code;
            // Retry on 429 (rate limit) and 5xx (server errors)
            if ((code === 429 || code >= 500) && attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt); // 1s, 2s, 4s
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
            return response; // Non-retryable error, return as-is
        }

        return response; // Success
    }
}

// ----------------------------------------------------------------
// Email & Social Link Scraper (Beta)
// ----------------------------------------------------------------
async function extractEmailsAndSocials(context: IExecuteFunctions, websiteUrl: string): Promise<{ emails: string[], social_links: string[] }> {
    if (!websiteUrl) return { emails: [], social_links: [] };

    try {
        // SSRF Protection: Block private, local, link-local, and metadata ranges
        const urlObj = new URL(websiteUrl);
        const host = urlObj.hostname;

        // Block non-HTTP schemes (e.g., file://, ftp://, gopher://)
        const acceptedSchemes = ['http:', 'https:'];
        if (!acceptedSchemes.includes(urlObj.protocol)) {
            console.warn(`Blocked non-HTTP scheme: ${urlObj.protocol}`);
            return { emails: [], social_links: [] };
        }

        // Block all bare numeric IPv4 addresses — legitimate sites use hostnames
        const isNumericIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
        if (isNumericIPv4) {
            console.warn(`Blocked numeric IPv4 address: ${host}`);
            return { emails: [], social_links: [] };
        }

        const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
        const isPrivateIP = /^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^192\.168\.|^169\.254\./.test(host);
        const isMetadata = host === 'metadata.google.internal';

        if (isLocalHost || isPrivateIP || isMetadata) {
            console.warn(`Blocked attempt to access private/local IP: ${host}`);
            return { emails: [], social_links: [] };
        }

        const html = await context.helpers.httpRequest({
            method: 'GET',
            url: websiteUrl,
            timeout: 5000,
            ignoreHttpStatusErrors: true,
        });

        if (typeof html !== 'string') return { emails: [], social_links: [] };

        const safeHtml = html.slice(0, 150000);

        // Regex match emails
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
        const emailMatches = safeHtml.match(emailRegex) || [];
        // Filter out common image extensions / false positives
        const cleanEmails = [...new Set(emailMatches)].filter(e =>
            !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.jpeg') &&
            !e.endsWith('.gif') && !e.endsWith('.svg') && !e.endsWith('.webp') &&
            !e.includes('sentry.io') && !e.includes('example.com') && !e.includes('domain.com')
        );

        // Regex match social links
        const socialRegex = /(https?:\/\/(?:www\.)?(?:instagram\.com|linkedin\.com|facebook\.com|twitter\.com|x\.com)\/[^"'\s<>]+)/ig;
        const socialMatches = safeHtml.match(socialRegex) || [];
        const cleanSocials = [...new Set(socialMatches)].filter(url =>
            !url.includes('/share') && !url.includes('/sharer') && !url.includes('/intent')
        );

        return { emails: cleanEmails.slice(0, 10), social_links: cleanSocials.slice(0, 10) };
    } catch (e) {
        return { emails: [], social_links: [] };
    }
}

function getFieldMask(dataFields: string, prefix: string = '') {
    const p = prefix ? `${prefix}.` : '';
    const basicFields = [
        `${p}id`, `${p}displayName`, `${p}formattedAddress`, `${p}location`, `${p}primaryType`,
        `${p}rating`, `${p}userRatingCount`
    ];
    const contactFields = [`${p}nationalPhoneNumber`, `${p}websiteUri`];
    const fullFields = [
        `${p}utcOffsetMinutes`,
        `${p}regularOpeningHours.periods`, `${p}regularOpeningHours.weekdayDescriptions`,
        `${p}currentOpeningHours.openNow`,
        `${p}priceLevel`,
        `${p}reviews.rating`, `${p}reviews.text`, `${p}reviews.publishTime`, `${p}reviews.relativePublishTimeDescription`, `${p}reviews.authorAttribution.displayName`,
        `${p}photos.heightPx`, `${p}photos.widthPx`, `${p}photos.name`,
    ];

    let selectedFields = [...basicFields];
    if (dataFields === 'contact' || dataFields === 'full') {
        selectedFields = selectedFields.concat(contactFields);
    }
    if (dataFields === 'full') {
        selectedFields = selectedFields.concat(fullFields);
    }
    return selectedFields;
}

// ----------------------------------------------------------------
// Place Result Transformer (DRY helper for search operations)
// ----------------------------------------------------------------
async function transformPlaceResults(
    context: IExecuteFunctions,
    places: any[],
    extractEmails: boolean,
    dataFields: string = 'basic',
    nodeItemIndex: number = 0
): Promise<any[]> {
    const transformed: any[] = [];

    for (const responseData of (places || [])) {
        const finalJson: any = {
            name: responseData.displayName?.text || '',
            address: responseData.formattedAddress || '',
            rating: responseData.rating || 0,
            reviews_count: responseData.userRatingCount || 0,
            phone: responseData.nationalPhoneNumber || '',
            website: responseData.websiteUri || '',
            primary_type: responseData.primaryType || '',
            place_id: responseData.id || '',
            geometry: { lat: responseData.location?.latitude || 0, lng: responseData.location?.longitude || 0 },
        };

        if (dataFields === 'full') {
            finalJson.price_level = responseData.priceLevel || 0;

            const reviewSort = context.getNodeParameter('reviewSort', nodeItemIndex, 'MOST_RELEVANT') as string;
            const reviewMinRating = context.getNodeParameter('reviewMinRating', nodeItemIndex, 1) as number;
            const reviewMaxRating = context.getNodeParameter('reviewMaxRating', nodeItemIndex, 5) as number;
            const reviewKeyword = context.getNodeParameter('reviewKeyword', nodeItemIndex, '') as string;

            let reviews = responseData.reviews || [];

            reviews = reviews.filter((review: any) => {
                const r = review.rating || 0;
                return r >= reviewMinRating && r <= reviewMaxRating;
            });

            if (reviewKeyword.trim() !== '') {
                const keywordLower = reviewKeyword.toLowerCase();
                reviews = reviews.filter((review: any) => {
                    const text = review.text?.text || '';
                    return text.toLowerCase().includes(keywordLower);
                });
            }

            if (reviewSort === 'NEWEST') {
                reviews.sort((a: any, b: any) => {
                    const dateA = new Date(a.publishTime || 0).getTime();
                    const dateB = new Date(b.publishTime || 0).getTime();
                    return dateB - dateA; // newest first
                });
            }

            finalJson.reviews = reviews.map((review: any) => ({
                rating: review.rating || 0,
                text: review.text?.text || '',
                author_name: review.authorAttribution?.displayName || '',
                publish_time: review.publishTime || '',
                relative_time: review.relativePublishTimeDescription || '',
            }));

            if (responseData.regularOpeningHours) {
                finalJson.opening_hours = {
                    open_now: responseData.currentOpeningHours?.openNow ?? false,
                    weekday_text: responseData.regularOpeningHours?.weekdayDescriptions || [],
                };
            }

            finalJson.photos = responseData.photos?.map((photo: any) => ({
                photo_reference: photo.name || '',
                width: photo.widthPx || 0,
                height: photo.heightPx || 0,
            })) || [];
        }

        if (extractEmails && finalJson.website) {
            const extras = await extractEmailsAndSocials(context, finalJson.website);
            finalJson.emails = extras.emails;
            finalJson.social_links = extras.social_links;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        transformed.push(finalJson);
    }

    return transformed;
}

export class GoogleMaps implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Google Maps Agentic',
        name: 'googleMapsAgentic',
        icon: 'file:googleMaps.png',
        group: ['transform'],
        version: 1,
        subtitle: '={{$parameter["operation"]}}',
        description: 'Production-grade AI Agent Google Maps scraper. Paginated search, localized results, cost-controlled field masks, photo fetching, and exponential backoff.',
        defaults: {
            name: 'Google Maps Agentic',
        },
        inputs: ['main'],
        outputs: ['main'],
        credentials: [
            {
                name: 'googleMapsApi',
                required: true,
            },
        ],
        usableAsTool: true,
        properties: [
            {
                displayName: 'Operation',
                name: 'operation',
                type: 'options',
                noDataExpression: true,
                options: [
                    { name: '1. Text Search (Paginated)', value: 'text_search', description: 'Natural language search. Supports pagination up to 60 results. Includes all features (Emails, Reviews, etc).' },
                    { name: '2. Get Place Details', value: 'get_place_details', description: 'Deep scrape: reviews, hours, photos, contact info using a place_id.' },
                    { name: '3. Search Nearby', value: 'search_nearby', description: 'Search around a latitude/longitude with a radius. Includes all features.' },
                    { name: 'Geocode', value: 'maps_geocode', description: 'Convert an address into lat/lng coordinates.' },
                    { name: 'Reverse Geocode', value: 'maps_reverse_geocode', description: 'Convert coordinates into a readable address.' },
                    { name: 'Distance Matrix', value: 'maps_distance_matrix', description: 'Calculate travel times/distances between locations.' },
                    { name: 'Directions', value: 'maps_directions', description: 'Get A-to-B navigation steps.' },
                ],
                default: 'text_search',
            },
            // ----------------------------------------------------------------
            // DYNAMIC UI SCHEMA — Optional fields to support Gemini thought_signature
            // ----------------------------------------------------------------
            {
                displayName: 'Text Query or Address',
                name: 'textQuery',
                type: 'string',
                displayOptions: { show: { operation: ['text_search', 'maps_geocode'] } },
                default: '',
                description: 'For Text Search or Geocode. Examples: "plumbers in London", "123 Main St".',
            },
            {
                displayName: 'Latitude',
                name: 'latitude',
                type: 'number',
                displayOptions: { show: { operation: ['search_nearby', 'maps_reverse_geocode'] } },
                default: 0,
                description: 'For Search Nearby and Reverse Geocode.',
            },
            {
                displayName: 'Longitude',
                name: 'longitude',
                type: 'number',
                displayOptions: { show: { operation: ['search_nearby', 'maps_reverse_geocode'] } },
                default: 0,
                description: 'For Search Nearby and Reverse Geocode.',
            },
            {
                displayName: 'Radius (Meters)',
                name: 'radius',
                type: 'number',
                displayOptions: { show: { operation: ['search_nearby'] } },
                default: 1500,
                description: 'Search radius in meters (Search Nearby only).',
            },
            {
                displayName: 'Place ID',
                name: 'place_id',
                type: 'string',
                displayOptions: { show: { operation: ['get_place_details'] } },
                default: '',
                description: 'The Google place_id (for Get Place Details).',
            },
            {
                displayName: 'Origins',
                name: 'origins',
                type: 'string',
                displayOptions: { show: { operation: ['maps_distance_matrix', 'maps_directions'] } },
                default: '',
                description: 'For Distance Matrix or Directions. Example: "New York" or "40.7128,-74.0060".',
            },
            {
                displayName: 'Destinations',
                name: 'destinations',
                type: 'string',
                displayOptions: { show: { operation: ['maps_distance_matrix', 'maps_directions'] } },
                default: '',
                description: 'For Distance Matrix or Directions. Example: "Los Angeles".',
            },
            // --- PAGINATION ---
            {
                displayName: 'Max Results',
                name: 'maxResults',
                type: 'number',
                displayOptions: { show: { operation: ['text_search', 'search_nearby'] } },
                default: 20,
                description: 'Maximum number of results to return (Text Search only). Set to 60 to fetch all pages. Default is 20 (1 page).',
            },
            // --- ENRICHMENT ---
            {
                displayName: 'Extract Emails from Website (Beta)',
                name: 'extractEmails',
                type: 'boolean',
                displayOptions: { show: { operation: ['text_search', 'search_nearby', 'get_place_details'] } },
                default: false,
                description: 'Whether to visit the business website (if available) to scrape emails and social media links. Can increase execution time.',
            },
            // --- LOCALIZATION ---
            {
                displayName: 'Language Code',
                name: 'languageCode',
                type: 'string',
                default: '',
                description: 'ISO 639-1 language code for localized results. Examples: "en", "es", "ja", "ar". Leave empty for default.',
            },
            {
                displayName: 'Region Code',
                name: 'regionCode',
                type: 'string',
                default: '',
                description: 'ISO 3166-1 Alpha-2 region code for biased results. Examples: "US", "GB", "IN". Leave empty for default.',
            },
            // --- COST CONTROL ---
            {
                displayName: 'Data Fields',
                name: 'dataFields',
                type: 'options',
                displayOptions: { show: { operation: ['text_search', 'search_nearby', 'get_place_details'] } },
                options: [
                    { name: 'Basic (Free Tier)', value: 'basic', description: 'Name, address, coordinates, place_id, type. Lowest cost.' },
                    { name: 'Contact', value: 'contact', description: 'Basic + phone number + website.' },
                    { name: 'Full (Reviews + Hours + Photos)', value: 'full', description: 'All data including reviews, opening hours, price level, and photo references. Highest cost.' },
                ],
                default: 'basic',
                description: 'Controls which fields are fetched (Text Search, Search Nearby, Place Details).',
            },
            // --- REVIEW SORTING & FILTERING ---
            {
                displayName: 'Review Sort',
                name: 'reviewSort',
                type: 'options',
                displayOptions: { show: { operation: ['text_search', 'search_nearby', 'get_place_details'], dataFields: ['full'] } },
                options: [
                    { name: 'Most Relevant', value: 'MOST_RELEVANT', description: 'Default Google ranking by relevance.' },
                    { name: 'Newest First', value: 'NEWEST', description: 'Sort reviews chronologically, most recent first.' },
                ],
                default: 'MOST_RELEVANT',
                description: 'How to sort reviews. Only applies when Data Fields is set to Full.',
            },
            {
                displayName: 'Review Min Rating',
                name: 'reviewMinRating',
                type: 'number',
                typeOptions: { minValue: 1, maxValue: 5 },
                displayOptions: { show: { operation: ['text_search', 'search_nearby', 'get_place_details'], dataFields: ['full'] } },
                default: 1,
                description: 'Only return reviews with rating >= this value (1-5). Use 1 to return all. Use 4 for positive-only reviews.',
            },
            {
                displayName: 'Review Max Rating',
                name: 'reviewMaxRating',
                type: 'number',
                typeOptions: { minValue: 1, maxValue: 5 },
                displayOptions: { show: { operation: ['text_search', 'search_nearby', 'get_place_details'], dataFields: ['full'] } },
                default: 5,
                description: 'Only return reviews with rating <= this value (1-5). Use 3 to get negative reviews only for competitor analysis.',
            },
            {
                displayName: 'Review Keyword',
                name: 'reviewKeyword',
                type: 'string',
                displayOptions: { show: { operation: ['text_search', 'search_nearby', 'get_place_details'], dataFields: ['full'] } },
                default: '',
                description: 'Filter reviews containing a specific keyword (case-insensitive). Note: Google API limits responses to max 5 reviews total.',
            },

        ],
    };

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const items = this.getInputData();
        const returnData: INodeExecutionData[] = [];

        const credentials = await this.getCredentials('googleMapsApi');
        const apiKey = credentials.apiKey as string;

        if (!apiKey) {
            throw new NodeOperationError(this.getNode(), 'API Key is required!');
        }

        for (let i = 0; i < items.length; i++) {
            try {
                const operation = this.getNodeParameter('operation', i) as string;

                // Fetch all flattened parameters
                const textQuery = this.getNodeParameter('textQuery', i, '') as string;
                const lat = this.getNodeParameter('latitude', i, 0) as number;
                const lng = this.getNodeParameter('longitude', i, 0) as number;
                const radius = this.getNodeParameter('radius', i, 1500) as number;
                const placeId = this.getNodeParameter('place_id', i, '') as string;
                const origins = this.getNodeParameter('origins', i, '') as string;
                const destinations = this.getNodeParameter('destinations', i, '') as string;
                const maxResults = this.getNodeParameter('maxResults', i, 20) as number;
                const extractEmails = this.getNodeParameter('extractEmails', i, false) as boolean;
                const languageCode = this.getNodeParameter('languageCode', i, '') as string;
                const regionCode = this.getNodeParameter('regionCode', i, '') as string;
                const dataFields = this.getNodeParameter('dataFields', i, 'basic') as string;

                // Build dynamic headers for New Places API
                const newApiHeaders: { [key: string]: string } = {
                    'X-Goog-Api-Key': apiKey,
                    'Content-Type': 'application/json',
                };
                if (languageCode) newApiHeaders['X-Goog-Language-Code'] = languageCode;

                // ================================================================
                //  TEXT SEARCH — with full pagination support
                // ================================================================
                if (operation === 'text_search') {
                    if (!textQuery) { returnData.push({ json: { agent_error: 'Please provide a textQuery string.' } }); continue; }

                    const selectedFields = getFieldMask(dataFields, 'places');
                    selectedFields.push('nextPageToken'); // Always include for pagination
                    const searchFieldMask = selectedFields.join(',');

                    let allPlaces: any[] = [];
                    let pageToken: string | undefined = undefined;
                    const pageSize = Math.min(maxResults, 20); // API max per page is 20

                    do {
                        const body: any = { textQuery, pageSize };
                        if (regionCode) body.regionCode = regionCode;
                        if (languageCode) body.languageCode = languageCode;
                        if (pageToken) body.pageToken = pageToken;

                        const options = {
                            method: 'POST' as IHttpRequestMethods,
                            url: 'https://places.googleapis.com/v1/places:searchText',
                            body,
                            headers: { ...newApiHeaders, 'X-Goog-FieldMask': searchFieldMask },
                            json: true,
                            ignoreHttpStatusErrors: true,
                        };

                        const responseData = await httpRequestWithRetry(this, options);

                        if (responseData?.error) {
                            returnData.push({ json: { agent_error: `Google API Error: ${responseData.error.message}` } });
                            pageToken = undefined; // break pagination loop
                            continue;
                        }

                        const places = responseData?.places || [];
                        allPlaces = allPlaces.concat(places);
                        pageToken = responseData?.nextPageToken;

                        // Stop if we've reached the user's limit
                        if (allPlaces.length >= maxResults) {
                            allPlaces = allPlaces.slice(0, maxResults);
                            pageToken = undefined;
                        }
                    } while (pageToken);

                    if (allPlaces.length > 0) {
                        returnData.push({ json: { total_results: allPlaces.length, results: await transformPlaceResults(this, allPlaces, extractEmails, dataFields, i) } });
                    }

                    // ================================================================
                    //  SEARCH NEARBY
                    // ================================================================
                } else if (operation === 'search_nearby') {
                    if (lat === 0 && lng === 0) { returnData.push({ json: { agent_error: 'Please provide valid latitude and longitude.' } }); continue; }

                    const body: any = {
                        locationRestriction: {
                            circle: { center: { latitude: lat, longitude: lng }, radius },
                        },
                        maxResultCount: Math.min(maxResults, 20),
                    };
                    if (languageCode) body.languageCode = languageCode;
                    if (regionCode) body.regionCode = regionCode;

                    const selectedFields = getFieldMask(dataFields, 'places');
                    const searchFieldMask = selectedFields.join(',');

                    const options = {
                        method: 'POST' as IHttpRequestMethods,
                        url: 'https://places.googleapis.com/v1/places:searchNearby',
                        body,
                        headers: {
                            ...newApiHeaders,
                            'X-Goog-FieldMask': searchFieldMask,
                        },
                        json: true,
                        ignoreHttpStatusErrors: true,
                    };

                    const responseData = await httpRequestWithRetry(this, options);

                    if (responseData?.error) {
                        returnData.push({ json: { agent_error: `Google API Error: ${responseData.error.message}` } });
                        continue;
                    }

                    returnData.push({ json: { results: await transformPlaceResults(this, responseData?.places || [], extractEmails, dataFields, i) } });

                    // ================================================================
                    //  GET PLACE DETAILS — with Cost-Controlled Field Masks
                    // ================================================================
                } else if (operation === 'get_place_details') {
                    if (!placeId) { returnData.push({ json: { agent_error: 'Please provide a place_id.' } }); continue; }

                    const selectedFields = getFieldMask(dataFields, '');
                    const detailHeaders: { [key: string]: string } = {
                        'X-Goog-Api-Key': apiKey,
                        'X-Goog-FieldMask': selectedFields.join(','),
                    };
                    if (languageCode) detailHeaders['X-Goog-Language-Code'] = languageCode;

                    const options = {
                        method: 'GET' as IHttpRequestMethods,
                        url: `https://places.googleapis.com/v1/places/${placeId}`,
                        headers: detailHeaders,
                        json: true,
                        ignoreHttpStatusErrors: true,
                    };

                    const responseData = await httpRequestWithRetry(this, options);

                    if (responseData?.error) {
                        returnData.push({ json: { agent_error: `Google API Error: ${responseData.error.message}` } });
                        continue;
                    }

                    const mapped = await transformPlaceResults(this, [responseData], extractEmails, dataFields, i);
                    returnData.push({ json: mapped[0] });

                    // ================================================================
                    //  LEGACY APIs: Geocode, Reverse Geocode, Distance Matrix, Directions
                    //  Note: These APIs do not support header-based auth. The API key 
                    //  must be passed in the query string, which is inherently less secure 
                    //  but unavoidable for these specific endpoints.
                    // ================================================================
                } else {
                    let url = '';
                    const qs: { [key: string]: any } = { key: apiKey };
                    if (languageCode) qs.language = languageCode;
                    if (regionCode) qs.region = regionCode;

                    if (operation === 'maps_geocode') {
                        qs.address = textQuery;
                        if (!qs.address) { returnData.push({ json: { agent_error: 'textQuery (address) required' } }); continue; }
                        url = 'https://maps.googleapis.com/maps/api/geocode/json';
                    } else if (operation === 'maps_reverse_geocode') {
                        qs.latlng = `${lat},${lng}`;
                        url = 'https://maps.googleapis.com/maps/api/geocode/json';
                    } else if (operation === 'maps_distance_matrix') {
                        qs.origins = origins;
                        qs.destinations = destinations;
                        if (!qs.origins || !qs.destinations) { returnData.push({ json: { agent_error: 'origins and destinations required' } }); continue; }
                        url = 'https://maps.googleapis.com/maps/api/distancematrix/json';
                    } else if (operation === 'maps_directions') {
                        qs.origin = origins;
                        qs.destination = destinations;
                        if (!qs.origin || !qs.destination) { returnData.push({ json: { agent_error: 'origins and destinations required' } }); continue; }
                        url = 'https://maps.googleapis.com/maps/api/directions/json';
                    }

                    const options = {
                        method: 'GET' as IHttpRequestMethods,
                        url,
                        qs,
                        json: true,
                        ignoreHttpStatusErrors: true,
                    };

                    const responseData = await httpRequestWithRetry(this, options);

                    if (responseData?.status && responseData.status !== 'OK' && responseData.status !== 'ZERO_RESULTS') {
                        returnData.push({ json: { agent_error: `Google API Error: ${responseData.status} - ${responseData.error_message}` } });
                        continue;
                    }

                    let finalJson: any = responseData;

                    if ((operation === 'maps_geocode' || operation === 'maps_reverse_geocode') && responseData.results) {
                        finalJson = {
                            results: responseData.results.map((r: any) => ({
                                formatted_address: r.formatted_address,
                                location: r.geometry?.location,
                                place_id: r.place_id,
                            })),
                        };
                    } else if (operation === 'maps_distance_matrix' && responseData.rows) {
                        const flattenedDistances: any[] = [];
                        if (responseData.origin_addresses && responseData.destination_addresses) {
                            responseData.origin_addresses.forEach((origin: string, oIndex: number) => {
                                responseData.destination_addresses.forEach((dest: string, dIndex: number) => {
                                    const element = responseData.rows[oIndex]?.elements[dIndex];
                                    if (element && element.status === 'OK') {
                                        flattenedDistances.push({
                                            from: origin,
                                            to: dest,
                                            distance: element.distance?.text,
                                            duration: element.duration?.text,
                                        });
                                    }
                                });
                            });
                            finalJson = { routes: flattenedDistances };
                        }
                    } else if (operation === 'maps_directions' && responseData.routes) {
                        finalJson = {
                            routes: responseData.routes.map((route: any) => ({
                                summary: route.summary || '',
                                distance: route.legs[0]?.distance?.text || '',
                                duration: route.legs[0]?.duration?.text || '',
                                start_address: route.legs[0]?.start_address || '',
                                end_address: route.legs[0]?.end_address || '',
                            })),
                        };
                    }

                    returnData.push({ json: finalJson });
                }

            } catch (error) {
                if (this.continueOnFail()) {
                    returnData.push({ json: { error: (error as Error).message } });
                    continue;
                }
                throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
            }
        }

        return [returnData];
    }
}
