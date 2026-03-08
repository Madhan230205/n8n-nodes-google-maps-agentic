import {
    ICredentialType,
    INodeProperties,
} from 'n8n-workflow';

export class GoogleMapsApi implements ICredentialType {
    name = 'googleMapsApi';
    displayName = 'Google Maps API';
    // This ensures the credential object has an API key available
    // to use in the node's execute method.
    properties: INodeProperties[] = [
        {
            displayName: 'API Key',
            name: 'apiKey',
            type: 'string',
            typeOptions: { password: true },
            default: '',
            description: 'The API key for Google Maps Services (requires Places API, Geocoding API, Directions API, Distance Matrix API, and Elevation API enabled).',
        },
    ];
}
