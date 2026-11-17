# EV Route Planner

Mobile-first India-only EV road-trip planner for four-wheelers.

## Deploy to Vercel

1. Import this folder into a Vercel project.
2. Add `GOOGLE_MAPS_API_KEY` and `OPENCHARGEMAP_API_KEY` in Project Settings → Environment Variables for Production, Preview, and Development.
3. Enable billing, **Routes API**, and **Places API (New)** in Google Cloud. The Google key is used only on Vercel's server; do not expose it in browser code.
4. Deploy. The page calls only `/api/plan`; provider keys are never sent to the browser.

Google provides road routes and station discovery. Open Charge Map is searched independently along the route, then used to enrich close Google matches with connector, power, access and listed operational status. If Google station search is temporarily rate-limited, the plan still uses any Open Charge Map records returned. The app never claims a port is currently free: users must confirm operational status and connector compatibility before travelling.

## Operating limits

- Up to eight intermediate stops are supported in one round trip.
- The planner accepts a usable range from 100 to 1,000 km and holds a 15% range buffer.
- Recommendations are route-aware estimates, not navigation or a guarantee of station availability. Always open the station directions and confirm before driving.
