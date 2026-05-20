# FX-Net NextGen 🌪️
**Tactical Meteorological Workstation & Real-Time AWIPS Web Portal**

[![Deploy with Vercel](https://vercel.com/button)](https://fx-net-next-gen.vercel.app/)  
**Live Application:** [https://fx-net-next-gen.vercel.app/](https://fx-net-next-gen.vercel.app/)

---

## 👨‍💻 Overview & History
Developed by **Rodney Cuevas, Meteorologist**, **FX-Net NextGen** is a modern, lightning-fast web edition of NOAA’s legendary tactical field workstation.

In the late 1990s and 2000s, NOAA’s Forecast Systems Laboratory (FSL) engineered **FX-Net** as a lightweight client-server system allowing Incident Meteorologists (IMETs) at remote wildfires and field forecasters to access full AWIPS capabilities over low-bandwidth connections. 

**FX-Net NextGen** brings that exact tactical philosophy into the modern cloud era. Engineered with MapLibre GL JS, serverless edge routing, and direct government NOAA/NWS API integrations, this workstation provides forecasters with instant, synchronized multi-pane meteorological data without heavy local server requirements.

---

## ⚡ Key Features

### 🗺️ Multi-Pane Map Synchronization
- **Quad-Pane Layouts**: Seamlessly split your view into 1, 2, or 4 independent map panes.
- **Master Sync**: Lock all panes to a master view to instantly compare radar reflectivity, GOES infrared satellite, WPC surface fronts, and SPC severe weather outlooks across the exact same geographic region.

### 🚨 Real-Time Weather Alerts & Vector Watches
- **National Watchdog**: Polls official NWS feeds every 15 seconds for rapid convective updates. Live scrolling ticker displays new Tornado, Severe Thunderstorm, and Flash Flood warnings.
- **High-Fidelity Watch Vectors**: Directly integrates NOAA's REST MapServer feature service to draw pristine, county-precise polygon boundaries for Severe Thunderstorm and Tornado watches.
- **Universal Point Query**: Clicking anywhere on the map inside an alert instantly queries the NWS active alerts database, generating beautifully formatted, color-coded stacked HTML bulletins with full precautionary actions.

### 🛰️ Comprehensive Meteorological Guidance
- **Storm Prediction Center (SPC)**: Day 1–3 Convective Outlook polygons and real-time Mesoscale Discussions (MCDs).
- **Weather Prediction Center (WPC)**: Surface isobars, high/low pressure centers, QPF precipitation forecasts, and coded surface fronts.
- **National Hurricane Center (NHC)**: Tropical weather outlook areas, active storm cones, and tracking forecast points.
- **Surface Observations**: Real-time METAR station plotting (temperature, dew point, pressure, and wind barbs).
- **Interactive Soundings**: Clickable Skew-T log-P vertical atmospheric profile viewer across US sounding sites.

---

## 🚀 Cloud Deployment (Vercel)
This project comes fully configured for instant cloud hosting on **Vercel** with zero backend infrastructure needed:
- **Edge Rewrites (`vercel.json`)**: Bypasses strict CORS policies on government servers by automatically proxying NOAA and Aviation Weather Center endpoints directly at the global edge network.
- **Serverless Python (`api/drought-monitor.py`)**: Dynamically computes date offsets and retrieves high-fidelity US Drought Monitor GeoJSON.
- **Runtime Diagnostics (`api/log.py`)**: Captures client diagnostic logs directly into your Vercel runtime console.

---

## 💻 Local Development
To run the workstation locally on your macOS or Linux machine with full functionality:

```bash
# 1. Clone the repository
git clone https://github.com/Cuevman81/FX-Net-NextGen.git
cd FX-Net-NextGen

# 2. Start the local Python proxy server (Port 8888)
python3 server.py
```
Open your browser and navigate to [http://localhost:8888](http://localhost:8888).

---

## 📄 Legal & Disclaimer
Terminology, data feeds, and acronyms (AWIPS, FX-Net, WPC, SPC, NHC, METAR) are public domain properties of the United States Government (NOAA / National Weather Service) pursuant to 17 U.S.C. § 105. 

*Designed and maintained as an independent professional forecasting tool by Rodney Cuevas.*
