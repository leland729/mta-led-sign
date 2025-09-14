#!/usr/bin/env node

/**
 * NYC Subway Sign Server - No Cache Version
 * Fetches from MTA API on every request
 */

const express = require('express');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const MTA_API_KEY = process.env.MTA_API_KEY;
const MTA_FEED_G = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g';

// Station configuration
const STATIONS = {
  'G26': {
    name: 'Greenpoint Av',
    northDest: 'Court Sq',
    southDest: 'Church Av'
  },
  'G22': {
    name: 'Nassau Av',
    northDest: 'Court Sq',
    southDest: 'Church Av'
  }
};

// Store last good data in case MTA returns empty
let lastGoodData = {};

// Middleware
app.use(require('cors')());
app.use(express.json());

/**
 * Fetch GTFS data - no cache, fresh every time
 */
async function fetchGTFS() {
  console.log(`[FETCH] Getting data from MTA at ${new Date().toLocaleTimeString()}`);
  
  try {
    const headers = {};
    if (MTA_API_KEY) {
      headers['x-api-key'] = MTA_API_KEY;
    }

    const response = await fetch(MTA_FEED_G, { headers, timeout: 10000 });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = await response.buffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
    
    console.log(`[FETCH] Got ${feed.entity?.length || 0} entities`);
    
    return feed;
  } catch (error) {
    console.error('[FETCH] Error:', error.message);
    return null;
  }
}

/**
 * Get next train for a station/direction
 */
function getNextTrain(feed, stationId, direction) {
  if (!feed || !feed.entity) return null;
  
  const stopId = stationId + direction;
  const now = Math.floor(Date.now() / 1000);
  
  let nextTrain = null;
  let minTime = Infinity;
  
  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    
    for (const stop of entity.tripUpdate.stopTimeUpdate || []) {
      if (stop.stopId === stopId) {
        const time = stop.arrival?.time || stop.departure?.time;
        if (time && time > now && time < minTime) {
          minTime = time;
          nextTrain = {
            route: entity.tripUpdate.trip.routeId || 'G',
            minutes: Math.max(0, Math.round((time - now) / 60))
          };
        }
      }
    }
  }
  
  return nextTrain;
}

/**
 * Main API endpoint
 */
app.get('/api/next/:stationId', async (req, res) => {
  try {
    const stationId = req.params.stationId;
    const station = STATIONS[stationId];
    
    if (!station) {
      return res.status(404).json({ error: 'Unknown station' });
    }
    
    // Fetch fresh data from MTA every time
    const feed = await fetchGTFS();
    
    if (feed && feed.entity && feed.entity.length > 0) {
      // Got good data
      const northTrain = getNextTrain(feed, stationId, 'N');
      const southTrain = getNextTrain(feed, stationId, 'S');
      
      const response = {
        station: station.name,
        north: northTrain ? {
          dest: station.northDest,
          minutes: northTrain.minutes,
          route: northTrain.route
        } : null,
        south: southTrain ? {
          dest: station.southDest,
          minutes: southTrain.minutes,
          route: southTrain.route
        } : null,
        time: new Date().toISOString()
      };
      
      // Save as last good data
      lastGoodData[stationId] = response;
      
      console.log(`[API] ${stationId}: N=${northTrain?.minutes || '--'}min, S=${southTrain?.minutes || '--'}min`);
      res.json(response);
      
    } else {
      // MTA returned empty - use last good data if available
      console.log('[API] MTA returned empty, using last good data');
      
      if (lastGoodData[stationId]) {
        res.json(lastGoodData[stationId]);
      } else {
        res.json({
          station: station.name,
          north: null,
          south: null,
          time: new Date().toISOString()
        });
      }
    }
    
  } catch (error) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ 
      error: 'Service unavailable',
      north: null,
      south: null
    });
  }
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚇 Subway Sign Server (No Cache)`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔑 API Key: ${MTA_API_KEY ? 'Yes' : 'No'}`);
});