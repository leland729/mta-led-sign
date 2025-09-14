const fs = require('fs');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const buffer = fs.readFileSync('/tmp/gtfs_test.pb');
const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

console.log(`Feed has ${feed.entity.length} entities`);
console.log(`Feed timestamp: ${new Date(feed.header.timestamp * 1000).toLocaleString()}`);

let g26Count = 0;
let allGStops = new Set();

for (const entity of feed.entity) {
  if (entity.tripUpdate) {
    const routeId = entity.tripUpdate.trip.routeId;
    
    for (const stop of entity.tripUpdate.stopTimeUpdate || []) {
      if (stop.stopId) {
        // Collect all G-line stops
        if (stop.stopId.startsWith('G')) {
          allGStops.add(stop.stopId);
        }
        
        // Look specifically for G26
        if (stop.stopId.includes('G26')) {
          g26Count++;
          const arrivalTime = stop.arrival?.time || stop.departure?.time;
          if (arrivalTime) {
            const timeStr = new Date(arrivalTime * 1000).toLocaleTimeString();
            console.log(`Found ${stop.stopId}: Route ${routeId}, arrives ${timeStr}`);
          }
        }
      }
    }
  }
}

console.log(`\nTotal G26 stops found: ${g26Count}`);

console.log(`\nAll G-line stops in feed (showing first 30):`);
[...allGStops].sort().slice(0, 30).forEach(id => console.log(`  ${id}`));

// Check if maybe the stop IDs are different format
console.log(`\nLooking for any stops with '26' in them:`);
for (const entity of feed.entity) {
  if (entity.tripUpdate) {
    for (const stop of entity.tripUpdate.stopTimeUpdate || []) {
      if (stop.stopId && stop.stopId.includes('26')) {
        console.log(`  Found: ${stop.stopId}`);
        break;
      }
    }
  }
}
