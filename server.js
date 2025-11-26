// server.js
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');

// Initialize the Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Data file path
const DATA_FILE = path.join(__dirname, 'data.json');

// Middleware
app.use(express.static('public')); // Serve static files from 'public' directory
app.use(bodyParser.json()); // Parse JSON request bodies
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded request bodies

// --- Constants for Clustering ---
// Increased radius to better capture potentially spread-out sample data
const CLUSTER_RADIUS_METERS = 1000; // meters (Increased from 100)
const MINIMUM_CLUSTER_SIZE = 2; // Minimum riders needed to form a potential cluster core
const RECENT_BOOKING_MINUTES = 5; // Bookings must be within this many minutes to be considered for clustering

// --- Initialization ---

// Initialize data.json if it doesn't exist
async function initializeDataFile() {
    try {
        await fs.access(DATA_FILE);
        console.log('Data file exists:', DATA_FILE);
    } catch (error) {
        console.log('Creating new data file:', DATA_FILE);
        const initialData = {
            bookings: [], // Stores individual rider location updates
            trips: [] // Stores defined trip codes
        };
        // Write the initial structure to the file
        await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2));
    }
}

// --- Data Handling Helpers ---

// Helper function to read data from data.json
async function readData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(data); // Parse the JSON content
    } catch (error) {
        // If file is empty or contains invalid JSON, return a default structure
        if (error instanceof SyntaxError || error.code === 'ENOENT') {
            console.warn('Data file missing, empty, or contains invalid JSON. Returning default structure.');
            return { bookings: [], trips: [] };
        }
        console.error('Error reading data file:', error);
        throw new Error('Could not read data file'); // Rethrow other errors
    }
}

// Helper function to write data to data.json
async function writeData(data) {
    try {
        // Write the data object back to the file as formatted JSON
        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing data file:', error);
        throw new Error('Could not write to data file'); // Rethrow the error
    }
}

// --- API Endpoints ---

// Check if any trips are defined in the data file
app.get('/api/checkDataAvailability', async (req, res) => {
    console.log("API: /api/checkDataAvailability called");
    try {
        const data = await readData();
        // Check if the trips array exists and has at least one entry
        const hasTrips = data && Array.isArray(data.trips) && data.trips.length > 0;
        console.log("API: /api/checkDataAvailability result:", hasTrips);
        res.json(hasTrips); // Send boolean result
    } catch (error) {
        console.error("Error in checkDataAvailability:", error);
        res.status(500).json({ error: error.message }); // Send internal server error
    }
});

// Fetch all raw booking data (used for the side panel list)
app.get('/api/fetchData', async (req, res) => {
    console.log("API: /api/fetchData called");
    try {
        const data = await readData();
        // Return the bookings array, or an empty array if it doesn't exist
        res.json(data.bookings || []);
    } catch (error) {
        console.error("Error in fetchData:", error);
        res.status(500).json({ error: error.message }); // Send internal server error
    }
});

// Fetch the list of defined trip codes (used for QR code management)
app.get('/api/getTrips', async (req, res) => {
    console.log("API: /api/getTrips called");
    try {
        const data = await readData();
        // Return the trips array, or an empty array if it doesn't exist
        res.json(data.trips || []);
    } catch (error) {
        console.error('Error fetching trips:', error);
        res.status(500).json({ error: error.message }); // Send internal server error
    }
});


// Register (create) a new trip definition
app.post('/api/createTrip', async (req, res) => {
    console.log("API: /api/createTrip called with body:", req.body);
    try {
        const { tripCode } = req.body;

        // Validate input: tripCode must be a non-empty string
        if (!tripCode || typeof tripCode !== 'string' || tripCode.trim() === '') {
            console.warn('Create trip attempt with invalid code:', tripCode);
            return res.status(400).json({ error: 'Trip code must be provided and cannot be empty' });
        }

        // Standardize trip code: trim whitespace and convert to uppercase
        const code = tripCode.trim().toUpperCase();

        const data = await readData();

        // Check if a trip with this code already exists
        const codeExists = data.trips.some(trip => trip.code === code);
        if (codeExists) {
            console.warn(`Attempt to create existing trip code: ${code}`);
            return res.status(400).json({ error: `Trip code '${code}' already exists` });
        }

        // Add the new trip object to the trips array
        data.trips.push({ code, createdAt: new Date() });

        // Write the updated data back to the file
        await writeData(data);
        console.log(`Trip created successfully: ${code}`);
        // Respond with 201 Created status and success message
        res.status(201).json({ success: true, tripCode: code });

    } catch (error) {
        console.error('Error creating trip:', error);
        res.status(500).json({ error: 'Failed to create trip' }); // Send internal server error
    }
});

// Calculate and return cluster information for active trips
app.get('/api/getClusters', async (req, res) => {
    console.log("API: /api/getClusters called");
    try {
        const data = await readData();
        // Calculate clusters based on current bookings and defined trips
        const calculatedClusters = calculateClusters(data.bookings, data.trips);
        console.log("API: /api/getClusters returning calculated clusters:", JSON.stringify(calculatedClusters, null, 2));
        res.json(calculatedClusters); // Send the cluster results
    } catch (error) {
        console.error("Error in getClusters API:", error);
        res.status(500).json({ error: 'Failed to calculate clusters' }); // Send internal server error
    }
});

// Calculate and return health status for each defined trip
app.get('/api/getTripHealth', async (req, res) => {
    console.log("API: /api/getTripHealth called");
    try {
        const data = await readData();
        // Calculate health status based on booking timestamps
        const tripHealth = calculateTripHealth(data.bookings, data.trips);
        console.log("API: /api/getTripHealth returning health:", JSON.stringify(tripHealth, null, 2));
        res.json(tripHealth); // Send the health status results
    } catch (error) {
        console.error("Error in getTripHealth API:", error);
        res.status(500).json({ error: 'Failed to calculate trip health' }); // Send internal server error
    }
});

// --- Calculation Functions ---

/**
 * Calculates clusters of riders based on proximity and recent location updates.
 * Uses a simplified DBSCAN-like approach.
 * @param {Array} bookings - Array of all booking/location update objects.
 * @param {Array} trips - Array of defined trip objects {code, createdAt}.
 * @returns {Object} - An object where keys are trip codes and values are cluster details
 * (center, strength, riderCount, totalRiders, timestamp, riders list).
 */
function calculateClusters(bookings, trips) {
    console.log(`Calculating clusters from ${bookings?.length ?? 0} bookings and ${trips?.length ?? 0} trips.`);
    const tripClusterResults = {}; // Object to store the final cluster result for each trip
    // Calculate the cutoff time for recent bookings
    const cutoffTime = Date.now() - (RECENT_BOOKING_MINUTES * 60 * 1000);

    // Ensure bookings is a valid array, default to empty if not
    const validBookings = Array.isArray(bookings) ? bookings : [];

    // Filter bookings:
    // 1. Must have valid timestamp, lat, lng.
    // 2. Timestamp must be within the RECENT_BOOKING_MINUTES cutoff.
    const recentBookings = validBookings.filter(booking => {
        if (!booking || typeof booking.timestamp === 'undefined' || typeof booking.lat !== 'number' || typeof booking.lng !== 'number') return false;
        const bookingTime = new Date(booking.timestamp).getTime();
        // Check if bookingTime is a valid number and is recent enough
        return !isNaN(bookingTime) && bookingTime >= cutoffTime;
    });
    console.log(`Found ${recentBookings.length} recent bookings (within last ${RECENT_BOOKING_MINUTES} mins).`);

    // Group recent bookings by their trip code
    const bookingsByTrip = {};
    recentBookings.forEach(booking => {
        if (!bookingsByTrip[booking.tripCode]) {
            bookingsByTrip[booking.tripCode] = []; // Initialize array if trip code not seen yet
        }
        bookingsByTrip[booking.tripCode].push(booking); // Add booking to the trip's list
    });

    // Calculate the total number of unique riders ever seen for each trip (using *all* valid bookings)
    const totalRidersPerTrip = {};
    validBookings.forEach(booking => {
        if (booking && booking.tripCode && booking.riderId) {
            if (!totalRidersPerTrip[booking.tripCode]) {
                totalRidersPerTrip[booking.tripCode] = new Set(); // Use a Set for automatic uniqueness
            }
            totalRidersPerTrip[booking.tripCode].add(booking.riderId); // Add rider ID to the set
        }
    });
    console.log("Total unique riders per trip calculated:", Object.keys(totalRidersPerTrip).map(k => `${k}: ${totalRidersPerTrip[k]?.size ?? 0}`).join(', '));


    // --- Process each trip that has recent bookings ---
    Object.keys(bookingsByTrip).forEach(tripCode => {
        const recentTripRiders = bookingsByTrip[tripCode]; // Get recent riders for this specific trip
        console.log(`Processing trip ${tripCode} with ${recentTripRiders.length} recent riders.`);

        // Skip this trip if it doesn't have enough recent riders to potentially form a cluster
        if (recentTripRiders.length < MINIMUM_CLUSTER_SIZE) {
            console.log(`Skipping trip ${tripCode}: Not enough recent riders (${recentTripRiders.length} < ${MINIMUM_CLUSTER_SIZE}).`);
            return; // Continue to the next trip code in the loop
        }

        // Map recent rider bookings to point objects needed for DBSCAN
        const points = recentTripRiders.map(booking => ({
            lat: booking.lat,
            lng: booking.lng,
            riderId: booking.riderId,
            timestamp: booking.timestamp,
            accuracy: typeof booking.accuracy === 'number' && booking.accuracy > 0 ? booking.accuracy : 50 // Default accuracy if missing/invalid
        }));

        // --- Simplified DBSCAN Implementation for this trip ---
        const tripSpecificClusters = []; // Array to hold clusters found *for this trip*
        const visited = new Set(); // Set to track indices of points already visited/processed globally

        points.forEach((point, index) => {
            if (visited.has(index)) return; // Skip if this point has already been assigned to a cluster or marked as noise
            visited.add(index); // Mark current point as visited

            // Find neighbors within the defined radius for the current point
            const neighborIndices = getNeighbors(point, index, points, CLUSTER_RADIUS_METERS);

            // Check if the current point is a 'core' point (has enough neighbors including itself)
            if (neighborIndices.length + 1 >= MINIMUM_CLUSTER_SIZE) {
                // --- Start a new cluster ---
                const currentClusterPoints = [point]; // Initialize cluster with the core point itself
                const queue = [...neighborIndices]; // Queue of neighbor indices to process
                const currentClusterIndices = new Set([index]); // Track indices added to *this specific cluster*

                // --- Expand the cluster ---
                while (queue.length > 0) {
                    const neighborIndex = queue.shift(); // Get the next neighbor index from the queue

                    // Skip if this neighbor index has already been visited globally or added to this cluster search path
                    if (visited.has(neighborIndex)) continue;

                    const neighborPoint = points[neighborIndex];
                    currentClusterPoints.push(neighborPoint); // Add the neighbor point to the current cluster
                    visited.add(neighborIndex); // Mark globally visited
                    currentClusterIndices.add(neighborIndex); // Mark visited for this cluster search

                    // Find neighbors of *this* neighbor
                    const neighborsOfNeighbor = getNeighbors(neighborPoint, neighborIndex, points, CLUSTER_RADIUS_METERS);

                    // If this neighbor is *also* a core point, add its unvisited neighbors to the queue
                    if (neighborsOfNeighbor.length + 1 >= MINIMUM_CLUSTER_SIZE) {
                        neighborsOfNeighbor.forEach(idx => {
                            if (!visited.has(idx)) { // Only add if not already visited globally
                                queue.push(idx);
                            }
                        });
                    }
                    // If the neighbor is not a core point, it becomes a border point of this cluster,
                    // but we don't expand further from it.
                } // End while loop (cluster expansion)

                // Add the completed cluster (as an array of points) to the list for this trip
                // (We already checked the initial core point, expansion ensures size >= MINIMUM_CLUSTER_SIZE)
                 console.log(`Found potential cluster for trip ${tripCode} with ${currentClusterPoints.length} riders.`);
                 tripSpecificClusters.push(currentClusterPoints);

            } else {
                // Point is noise (not a core point, might become a border point later if found by another core point)
                // console.log(`Point ${index} (Rider ${point.riderId}) for trip ${tripCode} is initially noise.`);
            }
        }); // End DBSCAN point iteration for this trip

        // --- Post-DBSCAN processing for this trip ---
        if (tripSpecificClusters.length > 0) {
            console.log(`Found ${tripSpecificClusters.length} potential cluster(s) for trip ${tripCode}. Selecting the largest.`);

            // Find the largest cluster among those found for this trip (based on number of points)
            let largestCluster = tripSpecificClusters.reduce((largest, current) =>
                current.length > largest.length ? current : largest
            );
            console.log(`Largest cluster for trip ${tripCode} has ${largestCluster.length} riders.`);

            // Calculate properties of the largest cluster
            const center = calculateWeightedCenter(largestCluster); // Calculate weighted center based on accuracy
            const clusterRiderCount = largestCluster.length; // Number of riders in this specific cluster
            // Get total unique riders for this trip (fallback to cluster count if trip wasn't in totalRidersPerTrip)
            const totalRidersForThisTrip = totalRidersPerTrip[tripCode]?.size || clusterRiderCount;
            // Calculate strength: proportion of total riders who are in the cluster
            const strength = totalRidersForThisTrip > 0 ? (clusterRiderCount / totalRidersForThisTrip) : 0;

            // Store the result for this trip if a center was successfully calculated
            if (center) {
                tripClusterResults[tripCode] = {
                    tripCode,
                    center, // {lat, lng} object
                    strength: Math.min(1, strength), // Cap strength at 100%
                    riderCount: clusterRiderCount, // Riders physically in this cluster calculation
                    totalRiders: totalRidersForThisTrip, // Total unique riders associated with the trip
                    timestamp: new Date(), // Timestamp of when this cluster was calculated
                    riders: largestCluster.map(p => p.riderId) // List of rider IDs currently in the cluster
                };
                console.log(`Stored cluster result for ${tripCode}: Center=(${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}), Strength=${(strength*100).toFixed(1)}%`);
            } else {
                console.warn(`Could not calculate center for largest cluster of trip ${tripCode}. Cluster not stored.`);
            }

        } else {
            console.log(`No clusters met minimum size criteria for trip ${tripCode}.`);
        }
    }); // End trip processing loop

    console.log("Cluster calculation finished.");
    return tripClusterResults; // Return the object containing results for each trip
}


/**
 * Calculates the geometric center of a list of points, weighted by inverse accuracy.
 * More accurate points (lower accuracy value) contribute more to the center calculation.
 * @param {Array} points - Array of point objects {lat, lng, accuracy}.
 * @returns {Object|null} - An object {lat, lng} representing the center, or null if calculation fails.
 */
function calculateWeightedCenter(points) {
    if (!points || points.length === 0) {
        console.warn("calculateWeightedCenter called with empty or invalid points array.");
        return null;
    }

    let sumLatWeight = 0;
    let sumLngWeight = 0;
    let totalWeight = 0;

    points.forEach(point => {
        // Use inverse of accuracy as weight. Handle potential issues:
        // - Default accuracy if missing/invalid (already done in points mapping)
        // - Ensure accuracy is not zero to avoid division by zero.
        const accuracy = Math.max(point.accuracy, 1); // Ensure accuracy is at least 1 meter
        const weight = 1 / accuracy;

        // Check for valid numbers before adding to sums
        if (typeof point.lat === 'number' && typeof point.lng === 'number' && !isNaN(point.lat) && !isNaN(point.lng) && !isNaN(weight)) {
            sumLatWeight += point.lat * weight;
            sumLngWeight += point.lng * weight;
            totalWeight += weight;
        } else {
            console.warn("Skipping point with invalid data in calculateWeightedCenter:", point);
        }
    });

    // Avoid division by zero if totalWeight is 0 (e.g., all points had invalid data)
    if (totalWeight === 0) {
        console.warn("Total weight is zero in calculateWeightedCenter, cannot compute weighted center.");
        // Fallback: Calculate simple average if possible
        const validPoints = points.filter(p => typeof p.lat === 'number' && typeof p.lng === 'number' && !isNaN(p.lat) && !isNaN(p.lng));
        if (validPoints.length > 0) {
            console.log("Falling back to simple average center.");
            let sumLat = 0;
            let sumLng = 0;
            validPoints.forEach(p => { sumLat += p.lat; sumLng += p.lng; });
            return {
                lat: sumLat / validPoints.length,
                lng: sumLng / validPoints.length
            };
        }
        return null; // Cannot calculate center even with fallback
    }

    // Return the weighted average coordinates
    return {
        lat: sumLatWeight / totalWeight,
        lng: sumLngWeight / totalWeight
    };
}

/**
 * Finds indices of neighboring points within a given radius using Haversine distance.
 * @param {Object} point - The reference point {lat, lng}.
 * @param {number} pointIndex - The index of the reference point in the allPoints array.
 * @param {Array} allPoints - Array of all point objects {lat, lng}.
 * @param {number} radiusMeters - The maximum distance for a point to be considered a neighbor.
 * @returns {Array<number>} - An array of indices of the neighboring points.
 */
function getNeighbors(point, pointIndex, allPoints, radiusMeters) {
    const neighbors = [];
    // Basic check for valid coordinates in the reference point
    if (typeof point.lat !== 'number' || typeof point.lng !== 'number' || isNaN(point.lat) || isNaN(point.lng)) {
         console.warn(`Invalid coordinates for reference point at index ${pointIndex}:`, point);
         return []; // Return empty array if reference point is invalid
    }

    for (let i = 0; i < allPoints.length; i++) {
        if (i === pointIndex) continue; // Don't compare point to itself

        const otherPoint = allPoints[i];
        // Basic check for valid coordinates in the other point
        if (typeof otherPoint.lat !== 'number' || typeof otherPoint.lng !== 'number' || isNaN(otherPoint.lat) || isNaN(otherPoint.lng)) {
            // console.warn(`Skipping neighbor check due to invalid coordinates for point at index ${i}:`, otherPoint);
            continue; // Skip this point if its coordinates are invalid
        }

        // Calculate distance using Haversine formula
        const distance = calculateHaversineDistance(point.lat, point.lng, otherPoint.lat, otherPoint.lng);

        // If the distance is within the specified radius, add its index to the neighbors list
        if (distance <= radiusMeters) {
            neighbors.push(i);
        }
    }
    // if (neighbors.length > 0) {
    //     console.log(`Point ${pointIndex} has ${neighbors.length} neighbors within ${radiusMeters}m.`);
    // }
    return neighbors;
}


/**
 * Calculates the distance between two geographic coordinates using the Haversine formula.
 * @param {number} lat1 - Latitude of the first point in degrees.
 * @param {number} lon1 - Longitude of the first point in degrees.
 * @param {number} lat2 - Latitude of the second point in degrees.
 * @param {number} lon2 - Longitude of the second point in degrees.
 * @returns {number} - The distance between the two points in meters.
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's mean radius in meters
    const φ1 = lat1 * Math.PI / 180; // Convert latitudes to radians
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180; // Difference in latitude in radians
    const Δλ = (lon2 - lon1) * Math.PI / 180; // Difference in longitude in radians

    // Haversine formula calculation
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // Angular distance in radians

    return R * c; // Distance in meters
}

/**
 * Calculates the health status of each defined trip based on the recency of bookings.
 * @param {Array} bookings - Array of all booking/location update objects.
 * @param {Array} trips - Array of defined trip objects {code, createdAt}.
 * @returns {Object} - An object where keys are trip codes and values are health status objects
 * {status: 'ACTIVE'|'STALE'|'INACTIVE'|'NO_SIGNAL', message, lastUpdate}.
 */
function calculateTripHealth(bookings, trips) {
    const tripHealth = {}; // Object to store health status for each trip
    const now = Date.now(); // Current time for comparison

    // Ensure trips and bookings are valid arrays, default to empty if not
    const validTrips = Array.isArray(trips) ? trips : [];
    const validBookings = Array.isArray(bookings) ? bookings : [];

    // Process each *defined* trip
    validTrips.forEach(trip => {
        const tripCode = trip.code;
        // Find all bookings associated with this specific trip code
        const tripBookings = validBookings.filter(b => b && b.tripCode === tripCode);

        // Case 1: No bookings ever recorded for this trip code
        if (tripBookings.length === 0) {
            tripHealth[tripCode] = {
                status: 'NO_SIGNAL',
                message: 'No riders have joined or updated location for this trip yet.',
                lastUpdate: null
            };
            return; // Move to the next trip in the loop
        }

        // Case 2: Bookings exist, find the most recent valid one
        let latestTimestamp = 0;
        let latestBookingTimestampStr = null; // Store the original timestamp string/object

        tripBookings.forEach(booking => {
            // Check if booking and its timestamp are valid
            if (booking && typeof booking.timestamp !== 'undefined') {
                const bookingTime = new Date(booking.timestamp).getTime();
                // Check if bookingTime is a valid number and is more recent than the current latest
                if (!isNaN(bookingTime) && bookingTime > latestTimestamp) {
                    latestTimestamp = bookingTime;
                    latestBookingTimestampStr = booking.timestamp; // Store the timestamp value
                }
            }
        });

        // Check if we actually found a valid latest booking timestamp
        if (latestTimestamp === 0 || latestBookingTimestampStr === null) {
            tripHealth[tripCode] = {
                status: 'NO_SIGNAL', // Or maybe a different status like 'ERROR'?
                message: 'Could not determine the last valid update time for this trip.',
                lastUpdate: null
            };
            return; // Move to the next trip
        }

        // Calculate minutes since the last valid update
        const minutesSinceLastUpdate = (now - latestTimestamp) / (60 * 1000);

        // Determine health status based on recency thresholds
        if (minutesSinceLastUpdate <= 2) { // Active within last 2 minutes
            tripHealth[tripCode] = {
                status: 'ACTIVE',
                message: `Trip active. Last update < 2 min ago.`,
                lastUpdate: latestBookingTimestampStr // Store the actual timestamp
            };
        } else if (minutesSinceLastUpdate <= 10) { // Stale between 2 and 10 minutes
            tripHealth[tripCode] = {
                status: 'STALE',
                message: `Possibly stale. Last update ${Math.round(minutesSinceLastUpdate)} min ago.`,
                lastUpdate: latestBookingTimestampStr
            };
        } else { // Inactive if last update > 10 minutes ago
            tripHealth[tripCode] = {
                status: 'INACTIVE',
                message: `Inactive. Last update > 10 min ago (${Math.round(minutesSinceLastUpdate)} min).`,
                lastUpdate: latestBookingTimestampStr
            };
        }
    });

    return tripHealth; // Return the object containing health status for all defined trips
}


// --- Other Endpoints (initData, logBooking, fetchNewBookings, deleteTrip, resetData) ---

// Create sample/test data for specific trip codes
app.post('/api/initData', async (req, res) => {
    console.log("API: /api/initData called");
    try {
        const data = await readData();

        // Define sample trips with center points for data generation
        const sampleTrips = [
            { code: 'IKI490', center: { lat: 6.5244, lng: 3.3792 } }, // Lagos center
            { code: 'ABX123', center: { lat: 6.6000, lng: 3.3500 } }  // North Lagos area
        ];

        // Ensure the sample trip codes exist in the main trips list
        sampleTrips.forEach(t => {
            if (!data.trips.some(trip => trip.code === t.code)) {
                console.log(`Initializing sample trip definition: ${t.code}`);
                data.trips.push({ code: t.code, createdAt: new Date() });
            }
        });

        // Clear ONLY existing bookings for the specific sample trips being re-initialized
        const sampleTripCodes = new Set(sampleTrips.map(t => t.code));
        const originalBookingCount = data.bookings.length;
        data.bookings = data.bookings.filter(b => !sampleTripCodes.has(b.tripCode));
        console.log(`Cleared ${originalBookingCount - data.bookings.length} existing bookings for sample trips: ${Array.from(sampleTripCodes).join(', ')}`);

        // Create new sample booking data for each sample trip
        sampleTrips.forEach(t => {
            console.log(`Generating 10 sample bookings for trip: ${t.code}`);
            for (let i = 1; i <= 10; i++) { // Generate 10 riders per sample trip
                // Simulate locations slightly offset from the trip's center point
                const latOffset = (Math.random() - 0.5) * 0.015; // Random offset within ~ +/- 800m
                const lngOffset = (Math.random() - 0.5) * 0.015; // Random offset within ~ +/- 800m
                const lat = t.center.lat + latOffset;
                const lng = t.center.lng + lngOffset;
                const acc = 5 + Math.round(Math.random() * 45); // Random accuracy between 5 and 50 meters
                // Random timestamp within the last minute (60 * 1000 ms)
                const timestamp = new Date(Date.now() - Math.floor(Math.random() * 60 * 1000));

                // Add the generated booking to the data
                data.bookings.push({
                    tripCode: t.code,
                    riderId: `Rider-${i}-${t.code.substring(0, 2)}`, // Unique rider ID format
                    timestamp,
                    lat,
                    lng,
                    accuracy: acc
                });
            }
        });

        // Write the updated data (new trips and bookings) back to the file
        await writeData(data);
        console.log('Sample data initialized successfully.');
        res.json({ success: true }); // Respond with success

    } catch (error) {
        console.error("Error initializing sample data:", error);
        res.status(500).json({ error: 'Failed to initialize sample data' }); // Send internal server error
    }
});


// Log a booking location update received from a mobile client
app.post('/api/logBooking', async (req, res) => {
    console.log("API: /api/logBooking called with body:", req.body);
    try {
        // Destructure expected fields from the request body
        const { code, riderId, lat, lng, acc } = req.body;

        // --- Input validation ---
        if (!code || typeof code !== 'string' || code.trim() === '') {
            return res.status(400).json({ error: 'Valid trip code must be provided' });
        }
        const tripCode = code.trim().toUpperCase(); // Standardize trip code

        if (!riderId || typeof riderId !== 'string' || riderId.trim() === '') {
            return res.status(400).json({ error: 'Valid Rider ID must be provided' });
        }
        const currentRiderId = riderId.trim(); // Standardize rider ID

        // Parse coordinates and accuracy, ensuring they are numbers
        const latitude = parseFloat(lat);
        const longitude = parseFloat(lng);
        let accuracy = parseFloat(acc); // Use let as it might be modified

        if (isNaN(latitude) || isNaN(longitude)) {
            console.warn(`Invalid coordinates received (lat: ${lat}, lng: ${lng}) for ${currentRiderId} on trip ${tripCode}`);
            return res.status(400).json({ error: 'Valid latitude and longitude must be provided' });
        }
        // Handle invalid or missing accuracy
        if (isNaN(accuracy) || accuracy < 0) {
            console.warn(`Invalid or missing accuracy received (${acc}) for ${currentRiderId} on trip ${tripCode}. Setting to null.`);
            accuracy = null; // Store null if accuracy is invalid
        }

        const data = await readData();

        // Check if the provided trip code actually exists in the defined trips
        const tripExists = data.trips.some(trip => trip.code === tripCode);
        if (!tripExists) {
            console.warn(`Attempt to log booking for non-existent trip: ${tripCode} by ${currentRiderId}`);
            return res.status(400).json({ error: `Invalid trip code '${tripCode}'. This trip does not exist or may have ended.` });
        }

        // Prepare the new booking data object
        const newBookingData = {
            tripCode: tripCode,
            riderId: currentRiderId,
            timestamp: new Date(), // Use server time for consistency
            lat: latitude,
            lng: longitude,
            accuracy: accuracy // Store potentially null accuracy
        };

        // --- Upsert Logic: Update existing entry or add new one ---
        // Find the index of an existing booking for this rider on this trip
        const existingBookingIndex = data.bookings.findIndex(
            booking => booking.tripCode === tripCode && booking.riderId === currentRiderId
        );

        if (existingBookingIndex !== -1) {
            // Update the existing booking entry at the found index
            data.bookings[existingBookingIndex] = newBookingData;
            console.log(`Updated location for ${currentRiderId} in trip ${tripCode}`);
        } else {
            // Add as a new booking entry if no existing one was found
            data.bookings.push(newBookingData);
            console.log(`New location log for ${currentRiderId} added to trip ${tripCode}`);
        }

        // Write the modified data back to the file
        await writeData(data);
        // Respond with success message
        res.json({ success: true, message: `Location for ${currentRiderId} on trip ${tripCode} logged.` });

    } catch (error) {
        console.error('Error in /api/logBooking:', error);
        // Send generic internal server error message
        res.status(500).json({ error: 'An internal server error occurred while logging the booking.' });
    }
});


// Fetch new booking entries since a given timestamp (used for the event log)
app.get('/api/fetchNewBookings', async (req, res) => {
    console.log("API: /api/fetchNewBookings called with query:", req.query);
    try {
        // Get the 'since' timestamp from query params, default to 0 if missing or invalid
        let since = parseInt(req.query.since || 0);
        if (isNaN(since) || since < 0) {
            console.warn(`Invalid 'since' parameter (${req.query.since}). Defaulting to 0.`);
            since = 0;
        }
        console.log(`Fetching bookings since timestamp: ${since} (${new Date(since).toISOString()})`);

        const data = await readData();
        // Ensure bookings is a valid array
        const validBookings = Array.isArray(data.bookings) ? data.bookings : [];

        // Filter bookings:
        // 1. Must have a valid timestamp.
        // 2. Timestamp must be strictly greater than the 'since' value.
        const newBookings = validBookings
            .filter(booking => {
                if (!booking || typeof booking.timestamp === 'undefined') return false;
                const bookingTime = new Date(booking.timestamp).getTime();
                return !isNaN(bookingTime) && bookingTime > since;
            })
            .sort((a, b) => {
                // Sort descending (newest first) by timestamp for client convenience
                return new Date(b.timestamp) - new Date(a.timestamp);
            });

        console.log(`Found ${newBookings.length} new bookings since ${since}.`);
        res.json(newBookings); // Send the filtered and sorted bookings

    } catch (error) {
        console.error("Error in fetchNewBookings:", error);
        res.status(500).json({ error: 'Failed to fetch new bookings' }); // Send internal server error
    }
});


// Delete a specific trip definition and all its associated booking data
app.delete('/api/deleteTrip', async (req, res) => {
    console.log("API: /api/deleteTrip called with body:", req.body);
    try {
        const { tripCode } = req.body;

        // Validate input: tripCode must be a non-empty string
        if (!tripCode || typeof tripCode !== 'string' || tripCode.trim() === '') {
            return res.status(400).json({ error: 'Valid trip code must be provided in the request body' });
        }
        const codeToDelete = tripCode.trim().toUpperCase(); // Standardize trip code

        const data = await readData();

        const initialTripCount = data.trips.length;
        const initialBookingCount = data.bookings.length;

        // Filter out the trip definition to be deleted
        data.trips = data.trips.filter(trip => trip.code !== codeToDelete);
        const tripDeleted = data.trips.length < initialTripCount;

        // Filter out all booking entries associated with the deleted trip code
        data.bookings = data.bookings.filter(booking => booking.tripCode !== codeToDelete);
        const bookingsDeletedCount = initialBookingCount - data.bookings.length;

        // Write the modified data (without the deleted trip and its bookings) back to the file
        await writeData(data);

        if (tripDeleted) {
             console.log(`Trip ${codeToDelete} deleted. ${bookingsDeletedCount} associated bookings removed.`);
             res.json({ success: true, message: `Trip ${codeToDelete} and ${bookingsDeletedCount} associated bookings deleted.` });
        } else {
             console.warn(`Attempt to delete non-existent trip: ${codeToDelete}. Only removed ${bookingsDeletedCount} potential orphaned bookings.`);
             // Respond indicating trip wasn't found, but operation completed for bookings
             res.status(404).json({ success: false, message: `Trip code '${codeToDelete}' not found, but ${bookingsDeletedCount} associated bookings (if any) were removed.` });
        }

    } catch (error) {
        console.error('Error deleting trip:', error);
        res.status(500).json({ error: 'Failed to delete trip' }); // Send internal server error
    }
});


// Reset all application data (clear both trips and bookings arrays)
app.delete('/api/resetData', async (req, res) => {
    console.log("API: /api/resetData called");
    try {
        // Define the empty initial data structure
        const initialData = {
            bookings: [],
            trips: []
        };
        // Overwrite the data file with the empty structure
        await writeData(initialData);
        console.log('Application data reset successfully.');
        res.json({ success: true, message: 'All application data (trips and bookings) has been reset.' }); // Respond with success
    } catch (error) {
        console.error('Error resetting data:', error);
        res.status(500).json({ error: 'Failed to reset data' }); // Send internal server error
    }
});


// --- Server Start ---
async function start() {
    await initializeDataFile(); // Ensure data file exists before starting the server
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log(`Serving static files from: ${path.join(__dirname, 'public')}`);
        console.log(`Using data file: ${DATA_FILE}`);
        console.log(`Clustering Params: Radius=${CLUSTER_RADIUS_METERS}m, MinSize=${MINIMUM_CLUSTER_SIZE}, RecentMins=${RECENT_BOOKING_MINUTES}`);
    });
}

// Start the server process
start();
