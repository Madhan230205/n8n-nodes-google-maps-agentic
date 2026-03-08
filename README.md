<div align="center">
  <h1>🗺️ n8n-nodes-google-maps-agentic</h1>
  <p><b>The Ultimate Google Maps & Places API Scraper for n8n. Designed explicitly for AI Agents, B2B Lead Generation, and mass data extraction without rate limits.</b></p>
  
  [![npm version](https://badge.fury.io/js/n8n-nodes-google-maps-agentic.svg)](https://badge.fury.io/js/n8n-nodes-google-maps-agentic)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
</div>

---

**Are you tired of basic Google Maps nodes that just pull names and phone numbers, crash on large datasets, or fail when used by AI Agents?**

Welcome to `n8n-nodes-google-maps-agentic` — a complete, production-grade overhaul of Google Maps data extraction for **n8n**. If you are building automated **B2B Lead Generation workflows**, researching competitor reviews, or equipping **AI Agents** (like Google Gemini, OpenAI, Claude) with local search tools, this is the only node you need.

This node transforms the standard Maps API into a relentless business intelligence tool. It visits business websites natively, scrapes **Email Addresses**, **Instagram**, and **LinkedIn** links, and seamlessly bypasses Google's strict pagination limits—all while being 100% memory-safe to prevent n8n server crashes.

---

## 🚀 Why Choose This Node? (Value Proposition & Expertise)

Built from the ground up to solve the most painful scaling issues in n8n scraping workflows. 

1. **Memory-Safe Concurrency Processing**: Fetching 60 websites simultaneously used to crash n8n Docker containers with CPU panics. This node utilizes a fine-tuned `for...of` sequential loop with a 200ms sleep buffer, preventing DNS timeouts and Cloudflare bans.
2. **AI-Agent Schema Safe**: Conditionally hidden UI fields can cause AI models like Gemini to crash due to JSON Schema `thought_signature / allOf` validation errors. We've stripped out restrictive validations, allowing your LLMs to use this node as a flawless Native Tool.
3. **Data Protection Built-In**: Large raw HTML website bodies are truncated to 150kb limits *before* passing to Regex email matching—completely eliminating V8 Engine thread locks associated with catastrophic backtracking.

---

## ✨ Key Features & Capabilities

- 📧 **Native Email & Social Extraction**: Stop using expensive third-party tools. Send a Text Search, and this node will automatically extract `mailto:` email addresses and social media links directly from the local business's website.
- 🔄 **Automatic Pagination & Rate Limiting**: Effortlessly retrieves all 60 results from a text search using automatic token pagination and Exponential Backoff.
- 💸 **Cost-Controlled API Calls**: Stop overpaying Google! Use precise `Data Fields` masks (Basic, Contact, Full) to control API costs per request. Need just names and emails? Use the cheapest tier.
- ⭐ **Advanced Review Analysis Tools**: Fetch the newest reviews, filter for negative ratings (competitor analysis), or search for specific keywords inside reviews.
- 🌍 **Localization & Geo-Targeting**: Narrow results using exact `Language Code` and `Region Code` biasing. 

---

## 🛠️ How To Install

**Method 1: Quick Install (n8n UI) - Recommended**
1. Go to your n8n instance -> **Settings** -> **Community Nodes**.
2. Click **Install**.
3. Enter `n8n-nodes-google-maps-agentic` and click **Install**.

**Method 2: NPM (Self-Hosted/Docker)**
Run the following command in your n8n installation directory:
```bash
npm install -g n8n-nodes-google-maps-agentic
```

---

## 📋 Available Operations (The API Arsenal)

This node utilizes both the modern **Google Places API (New)** and the established routing APIs. 

1. **Text Search (Paginated)**: Natural language search (e.g., *"plumbers in London"*). Automatically fetches up to 60 results. **Includes full access to Emails, Reviews, and localization.**
2. **Search Nearby**: Find places around a specific Latitude/Longitude with a set radius limit. Includes all features.
3. **Get Place Details**: Deep scrape a specific `place_id` for granular hours, reviews, and photos.
4. **Get Photo**: Convert a Google Maps `photo_reference` into a raw `.jpg` URL stream.
5. **Geocode / Reverse Geocode**: Convert physical addresses into Latitude/Longitude coordinates or vice-versa.
6. **Distance Matrix**: Calculate real-time travel parameters (drive times, distances) between origins and destinations.
7. **Directions**: Get step-by-step navigation instructions.

---

## 💡 Practical Use Cases & Workflows

### 1. The Ultimate B2B Cold Email Pipeline
Turn Google Maps into an automated lead machine.
* **Workflow**: `Schedule Trigger` ➡️ `Google Maps Agentic` (Text Search: "Marketing agencies in Austin" + Extract Emails = True) ➡️ `OpenAI` (Write personalized intro email based on their Maps profile) ➡️ `Gmail/Outlook` (Send draft).

### 2. Automated Competitor Review Analysis
Understand exactly what customers hate about your competitors.
* **Workflow**: `Webhook Trigger` ➡️ `Google Maps Agentic` (Place Details: Max Rating 3, Sort: Newest) ➡️ `AI Agent` (Categorize poor reviews to find business improvement opportunities for your sales team).

### 3. AI Agent "Local Guide" Assistant
Give your AI Chatbot eyes into the real world.
* **Workflow**: Expose this node as a Tool to an AI Agent. When a user asks *"Find me a highly rated sushi place open now in Tokyo"*, the AI dynamically passes the parameters, queries the map, reads the reviews, and summarizes the best options natively.

---

## 🔑 Authentication Guide

You must use a Google Cloud Platform (GCP) account. Enable the following APIs in your GCP Console to unlock full functionality:
- **Places API (New)** *(Required for Search and Details)*
- Geocoding API
- Distance Matrix API
- Directions API

Create an API Key, restrict it if necessary, and insert it into the `Google Maps API` credential inside your n8n workspace.

---

## 🤝 Community, License & Support

Distributed under the MIT License. Designed and optimized by the n8n community to push the boundaries of seamless data scraping and LLM-powered AI workflows. 

*If you encounter an issue or have a feature request, please open an issue on the GitHub repository.* Happy automating!
