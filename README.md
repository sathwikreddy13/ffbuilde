# EV Route Planner

Mobile-first India-only EV road-trip planner for four-wheelers.

## Deploy to Vercel

1. Import this folder into a Vercel project.
2. Add `GOOGLE_MAPS_API_KEY` and `OPENCHARGEMAP_API_KEY` in Project Settings → Environment Variables (Production and Preview).
3. Enable billing, **Routes API**, and **Places API (New)** in Google Cloud.
4. Deploy. The page calls only `/api/plan`; provider keys are never sent to the browser.

Google provides driving route data and station discovery. Open Charge Map enriches nearby matches with connector, power, access and listed operational status. The app never claims a port is currently free.
