// Global variables
let map;
let markerCluster;
let defaultLocation = [6.5244, 3.3792]; // Lagos
let tripsData = {}; // Stores processed trip data { code, riders: { id: { ... } }, riderCount, etc. }
let clusters = {}; // Stores raw cluster data from /api/getClusters
let tripHealth = {}; // Stores raw health data from /api/getTripHealth
let eventLog = []; // Currently unused in UI
let lastEventTimestamp = 0;
let currentClusterMarkers = []; // Holds L.marker objects for shuttles
let previousMarkerCount = -1; // For conditional map zooming
let mapInitialized = false;
let qrActionListenerAdded = false; // Track if QR listener is added

// --- Initialization ---
function init() {
    try {
        console.log("Initializing application...");
        map = L.map('map', { minZoom: 2, zoomControl: true }).setView(defaultLocation, 12);

        // Setup Tile Layer
        const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors', maxZoom: 19, subdomains: 'abc'
        });
        tileLayer.on('tileerror', (error, tile) => {
             console.error('Tile Loading Error:', error, tile);
             showNotification('error', 'Map Error', 'Could not load some map tiles.');
        });
        tileLayer.addTo(map);

        // Initialize MarkerCluster group (unused for shuttles currently)
        markerCluster = L.markerClusterGroup();
        map.addLayer(markerCluster);

        // --- Event Listeners ---
        // Buttons in Panel
        document.getElementById('create-trip-btn')?.addEventListener('click', createTrip);
        document.getElementById('refresh-btn')?.addEventListener('click', refreshData);
        document.getElementById('init-test-data')?.addEventListener('click', initializeData);
        document.getElementById('reset-data')?.addEventListener('click', resetData);
        // Button in "No Data" message overlay
        document.getElementById('create-sample-data')?.addEventListener('click', initializeData);
        // Modal Listeners
        document.getElementById('modal-close-btn')?.addEventListener('click', hideQrModal);
        document.getElementById('qr-modal')?.addEventListener('click', (e) => { // Close modal on overlay click
            if (e.target.id === 'qr-modal') {
                hideQrModal();
            }
        });

        // Start background data polling
        initPolling();

        // Initial data check and rendering
        checkDataAvailability()
            .then(hasData => {
                console.log("Initial data availability check:", hasData);
                const noDataMsg = document.getElementById('no-data-message');
                if (hasData) {
                    // Fetch initial data immediately if trips exist
                    pollAndRender();
                    fetchClustersAndRender();
                    if(noDataMsg) noDataMsg.style.display = 'none';
                } else {
                    // Show "No Data" message if no trips are defined
                    if(noDataMsg) noDataMsg.style.display = 'flex'; // Use flex for alignment
                }
                document.getElementById('map-loading').style.display = 'none';
                mapInitialized = true;
                console.log("Map initialized successfully.");
            })
            .catch(error => {
                // Handle initialization errors
                console.error("App initialization error:", error);
                showNotification('error', 'Initialization Error', `Failed to initialize: ${error.message}`);
                document.getElementById('map-loading').style.display = 'none';
                 const noDataMsg = document.getElementById('no-data-message');
                 if(noDataMsg) noDataMsg.style.display = 'flex'; // Show message on error too
            });

    } catch (error) {
        // Catch fatal errors during map setup
        console.error("Fatal Map initialization error:", error);
        showNotification('error', 'Map Init Fatal Error', `Could not initialize map: ${error.message}`);
         const loadingEl = document.getElementById('map-loading');
         if(loadingEl) loadingEl.textContent = 'Error initializing map!';
    }
}

/**
 * Sets up intervals for polling various data endpoints.
 */
function initPolling() {
    console.log("Initializing polling intervals...");
    setInterval(pollAndRender, 15000); // Fetch rider data & update panel/stats
    setInterval(pollTrips, 30000); // Fetch defined trips for QR codes
    setInterval(fetchClustersAndRender, 5000); // Fetch cluster data for map shuttles (more frequent)
    setInterval(fetchTripHealth, 15000); // Fetch trip health for status badges
    // setInterval(fetchEvents, 7000); // Keep commented if event log not displayed

     // Fetch initial data immediately on load
     pollTrips();
     fetchTripHealth();
     // fetchEvents();
}

// --- Data Fetching Functions ---

/**
 * Checks if the server has any trip data defined.
 * @returns {Promise<boolean>} - True if data exists, false otherwise.
 */
async function checkDataAvailability() {
    console.log("Checking data availability...");
    try {
        const response = await fetch('/api/checkDataAvailability');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('Error checking data availability:', error);
        throw new Error(`Failed to check data availability. ${error.message}`);
    }
}

/**
 * Fetches the latest rider location data from the server.
 * Filters for the most recent update per rider per trip.
 * @returns {Promise<Array>} - An array of unique rider booking objects.
 */
async function fetchRiderData() {
    console.log("Polling for rider data...");
    document.getElementById('map-loading').style.display = 'flex'; // Show loading
    try {
        const response = await fetch('/api/fetchData');
        if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
        const data = await response.json();

        // Filter for unique, most recent rider locations
        const uniqueRiders = {};
        if (data && Array.isArray(data)) {
            data.forEach(booking => {
                if (!booking || !booking.tripCode || !booking.riderId || !booking.timestamp) return; // Skip invalid
                const key = `${booking.tripCode}-${booking.riderId}`;
                const bookingTime = new Date(booking.timestamp).getTime();
                if (isNaN(bookingTime)) return; // Skip invalid timestamps

                if (!uniqueRiders[key] || bookingTime > new Date(uniqueRiders[key].timestamp).getTime()) {
                    uniqueRiders[key] = booking;
                }
            });
        }
        const uniqueData = Object.values(uniqueRiders);
        console.log("Rider data fetched:", data ? data.length : 0, "rows,", uniqueData.length, "unique riders.");
        return uniqueData;
    } catch (error) {
        console.error("Rider data fetch error:", error);
        showNotification('error', 'Data Error', `Failed to fetch latest rider data: ${error.message}`);
        return []; // Return empty on error
    } finally {
        // Loading indicator hidden in pollAndRender to prevent flicker
    }
}

/**
 * Fetches cluster data (shuttle locations) from the server.
 * @returns {Promise<Object>} - The cluster data object.
 */
async function fetchClusters() {
    console.log("Fetching cluster data...");
    try {
        const response = await fetch('/api/getClusters');
        if (!response.ok) throw new Error(`Failed to fetch clusters (${response.status})`);
        const newClusters = await response.json();
        console.log("Clusters fetched:", Object.keys(newClusters).length);
        return newClusters;
    } catch (error) {
        console.error('Error fetching clusters:', error);
        showNotification('warning', 'Cluster Update Failed', `Could not get latest shuttle data: ${error.message}`);
        return clusters; // Return old data on error
    }
}

/**
 * Fetches trip health status from the server.
 */
async function fetchTripHealth() {
    console.log("Fetching trip health...");
    try {
        const response = await fetch('/api/getTripHealth');
        if (!response.ok) throw new Error(`Failed to fetch trip health (${response.status})`);
        tripHealth = await response.json(); // Update global object
        updateTripHealthIndicators(); // Update UI
        console.log("Trip health updated.");
    } catch (error) {
        console.error('Error fetching trip health:', error);
        // Avoid showing notification on every poll failure
    }
}

/**
 * Fetches new booking events since the last check. (Currently unused)
 */
async function fetchEvents() {
    // console.log(`Fetching events since: ${lastEventTimestamp}`);
    try {
        const response = await fetch(`/api/fetchNewBookings?since=${lastEventTimestamp}`);
        if (!response.ok) throw new Error(`Failed to fetch events (${response.status})`);
        const newEvents = await response.json();
        if (newEvents && newEvents.length > 0) {
            console.log(`Fetched ${newEvents.length} new events.`);
            // processNewEvents(newEvents); // Process if event log display is added
            lastEventTimestamp = Math.max(
                lastEventTimestamp,
                ...newEvents.map(e => new Date(e.timestamp).getTime())
            );
        }
    } catch (error) {
        console.error('Error fetching events:', error);
    }
}

/**
 * Fetches the list of currently defined trips (for QR codes).
 */
async function pollTrips() {
    console.log("Polling for defined trips...");
    try {
        const response = await fetch('/api/getTrips');
        if (!response.ok) throw new Error(`Failed to fetch trips (${response.status})`);
        const trips = await response.json();
        updateQRCodes(trips); // Update QR display
        // Update total trip count display in filters header
        const totalCountEl = document.getElementById('total-trip-count');
        if(totalCountEl) totalCountEl.textContent = trips.length;
        console.log("Defined trips updated:", trips.length);
    } catch (error) {
        console.error("Trips polling error:", error);
    }
}

// --- Data Processing and Rendering ---

/**
 * Main function to orchestrate fetching rider data and updating UI.
 */
async function pollAndRender() {
    const uniqueData = await fetchRiderData(); // Fetch latest rider locations
    if (uniqueData) {
        processTripsData(uniqueData); // Process into tripsData structure
        renderTripsPanel(); // Render the trip cards in the panel
        updateStats(); // Update map overlay stats

        // Update "No Data" message visibility
        const noDataMsg = document.getElementById('no-data-message');
        if (noDataMsg) {
             // Hide if we have riders OR clusters (shuttles)
            if (uniqueData.length > 0 || Object.keys(clusters).length > 0) {
                noDataMsg.style.display = 'none';
            } else if (mapInitialized) { // Show only if map is ready and still no data
                noDataMsg.style.display = 'flex';
            }
        }
    }
    // Hide loading indicator once processing is done
    document.getElementById('map-loading').style.display = 'none';
}

/**
 * Fetches cluster data and renders shuttles on the map.
 */
async function fetchClustersAndRender() {
    const newClusters = await fetchClusters();
    if (newClusters) {
        // Basic change detection (optional)
        // let clustersChanged = Object.keys(clusters).length !== Object.keys(newClusters).length;
        // if (clustersChanged) logClusterChanges(clusters, newClusters); // If event log is used

        clusters = newClusters; // Update global state
        renderShuttlesOnMap(); // Render markers
        updateStats(); // Update stats (active trips/riders might be affected indirectly)
    }
}

/**
 * Processes raw booking data into the structured tripsData object.
 * Calculates rider status based on timestamp.
 * @param {Array} bookings - Array of unique rider booking objects.
 */
function processTripsData(bookings) {
    tripsData = {}; // Reset before processing
    bookings.forEach(booking => {
        const tripCode = booking.tripCode;
        const riderId = booking.riderId;
        // Initialize trip if not present
        if (!tripsData[tripCode]) {
            tripsData[tripCode] = {
                code: tripCode,
                riders: {},
                riderCount: 0,
                // --- Add Placeholders for new data fields ---
                // These should ideally come from a different API endpoint
                // or be associated when the trip is created/fetched.
                startLocation: `Origin for ${tripCode}`, // Placeholder
                endLocation: `Destination for ${tripCode}`, // Placeholder
                driverName: `Driver ${tripCode.substring(0,1)}${Math.floor(Math.random()*100)}`, // Placeholder
                vehicleInfo: `Toyota Coaster ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))} - ${Math.floor(100 + Math.random() * 900)}XY`, // Placeholder
                startTime: new Date(Date.now() - Math.random() * 3600000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) // Placeholder
            };
        }
        // Calculate rider status
        const timeDiff = Date.now() - new Date(booking.timestamp).getTime();
        const status = timeDiff < 60000 ? 'active' : 'idle'; // Active if < 1 min ago
        // Add/update rider data
        tripsData[tripCode].riders[riderId] = {
            id: riderId,
            lastUpdate: new Date(booking.timestamp),
            status: status,
            location: { lat: booking.lat, lng: booking.lng, accuracy: booking.accuracy }
        };
    });
    // Update rider counts
    Object.keys(tripsData).forEach(tripCode => {
        tripsData[tripCode].riderCount = Object.keys(tripsData[tripCode].riders).length;
    });
}

/**
 * Renders the list of trips in the side panel using the new card design.
 */
function renderTripsPanel() {
    const tripsListContainer = document.getElementById('trips-list');
    if (!tripsListContainer) return;

    const tripsArray = Object.values(tripsData);
    tripsListContainer.innerHTML = ''; // Clear previous list

    // Update displayed trip count in filters header
    const displayedCountEl = document.getElementById('displayed-trip-count');
    if(displayedCountEl) displayedCountEl.textContent = tripsArray.length;

    if (tripsArray.length === 0) {
        tripsListContainer.innerHTML = '<p class="no-items">No active trips found.</p>';
        return;
    }

    // Sort trips (e.g., by code)
    const sortedTrips = tripsArray.sort((a, b) => a.code.localeCompare(b.code));

    sortedTrips.forEach(trip => {
        const tripCard = document.createElement('div');
        tripCard.className = 'trip-card';

        const activeRidersCount = Object.values(trip.riders).filter(rider => rider.status === 'active').length;

        // --- Render New Trip Card Structure ---
        // Using placeholders for data not currently available in tripsData
        tripCard.innerHTML = `
            <div class="trip-card-header">
                <div class="trip-card-main">
                    <div class="trip-card-locations">
                        <div class="location-item" title="${trip.startLocation || ''}">
                           <i class="fas fa-map-marker-alt"></i>
                           <span>${trip.startLocation || 'Start Unknown'}</span>
                        </div>
                        <div class="location-item" title="${trip.endLocation || ''}">
                           <i class="fas fa-flag-checkered"></i>
                           <span>${trip.endLocation || 'End Unknown'}</span>
                        </div>
                    </div>
                    <div class="trip-card-driver">
                        <div class="driver-avatar">${trip.driverName ? trip.driverName.charAt(0) : '?'}</div>
                        <div>
                            <div class="driver-name">${trip.driverName || 'Driver Unknown'}</div>
                            <div class="vehicle-info">${trip.vehicleInfo || 'Vehicle Unknown'}</div>
                        </div>
                    </div>
                    <div class="trip-card-details">
                        <span title="Trip Code">${trip.code}</span> |
                        <span title="Start Time">Started: ${trip.startTime || 'Time Unknown'}</span>
                    </div>
                </div>
                <div class="trip-card-status">
                    <span class="status-badge offline" title="Trip Status">Offline</span> </div>
            </div>
            <div class="trip-content">
                <ul class="rider-list"></ul>
                <div class="trip-summary">
                     <div class="trip-stat">
                        <div class="trip-stat-value">${trip.riderCount}</div>
                        <div class="trip-stat-label">Total</div>
                    </div>
                    <div class="trip-stat">
                        <div class="trip-stat-value status-active">${activeRidersCount}</div>
                        <div class="trip-stat-label">Active</div>
                    </div>
                    <div class="trip-stat">
                        <div class="trip-stat-value status-idle">${trip.riderCount - activeRidersCount}</div>
                        <div class="trip-stat-label">Idle</div>
                    </div>
                </div>
            </div>
        `;

        // --- Populate Rider List (Accordion Content) ---
        const ridersListUl = tripCard.querySelector('.rider-list');
        const sortedRiders = Object.values(trip.riders).sort((a, b) => {
            if (a.status === b.status) return a.id.localeCompare(b.id);
            return a.status === 'active' ? -1 : 1;
        });

        if (sortedRiders.length > 0) {
            sortedRiders.forEach(rider => {
                const timeAgo = getTimeAgo(rider.lastUpdate);
                const riderItem = document.createElement('li');
                riderItem.className = 'rider-item';
                riderItem.innerHTML = `
                    <div class="rider-info">
                        <div class="rider-avatar">${rider.id.charAt(0).toUpperCase()}</div>
                        <div>
                            <div class="rider-name">${rider.id}</div>
                            <div class="rider-status ${rider.status === 'active' ? 'status-active' : 'status-idle'}">
                                <i class="fas fa-${rider.status === 'active' ? 'signal' : 'clock'}"></i> ${timeAgo}
                            </div>
                        </div>
                    </div>
                    <div class="rider-accuracy" title="Location Accuracy">±${rider.location.accuracy ? rider.location.accuracy.toFixed(0) : '?'}m</div>
                `;
                // Add click listener to pan map to rider
                riderItem.addEventListener('click', (e) => {
                    e.stopPropagation(); // Prevent card header click from triggering
                    if (rider.location.lat && rider.location.lng) {
                        map.panTo([rider.location.lat, rider.location.lng]);
                        showNotification('info', 'Map Panned', `Showing location for Rider ${rider.id}`);
                    }
                });
                ridersListUl.appendChild(riderItem);
            });
        } else {
             ridersListUl.innerHTML = '<li class="no-items" style="padding: 0.5rem 0;">No riders on this trip yet.</li>';
        }


        // --- Add Accordion Toggle Listener ---
        const header = tripCard.querySelector('.trip-card-header');
        const content = tripCard.querySelector('.trip-content');
        header.addEventListener('click', () => {
            // Close other open trip cards first
            tripsListContainer.querySelectorAll('.trip-card .trip-content.active').forEach(openContent => {
                if (openContent !== content) openContent.classList.remove('active');
            });
            // Toggle current card's content
            content.classList.toggle('active');
        });

        tripsListContainer.appendChild(tripCard);
    });

     // Update health status badges after rendering all cards
     updateTripHealthIndicators();
}

/**
 * Updates the status badges on the trip cards based on fetched health data.
 */
function updateTripHealthIndicators() {
    const tripCards = document.querySelectorAll('#trips-list .trip-card');

    tripCards.forEach(card => {
        const detailsDiv = card.querySelector('.trip-card-details');
        const statusBadge = card.querySelector('.status-badge');
        if (!detailsDiv || !statusBadge) return;

        // Extract trip code reliably (assuming it's the first span in details)
        const tripCodeSpan = detailsDiv.querySelector('span');
        const tripCode = tripCodeSpan ? tripCodeSpan.textContent.trim() : null;

        if (tripCode) {
            const health = tripHealth[tripCode]; // Get health data for this trip

            if (health) {
                let statusText = 'Unknown';
                let statusClass = 'offline'; // Default class from CSS

                // Determine text and class based on health status
                switch (health.status) {
                    case 'ACTIVE': statusText = 'Online'; statusClass = 'online'; break;
                    case 'STALE': statusText = 'Idle'; statusClass = 'idle'; break;
                    case 'INACTIVE': statusText = 'Offline'; statusClass = 'offline'; break;
                    case 'NO_SIGNAL': statusText = 'No Signal'; statusClass = 'offline'; break; // Treat no signal as offline visually
                }
                statusBadge.textContent = statusText;
                statusBadge.className = `status-badge ${statusClass}`; // Update class for styling
                statusBadge.title = health.message; // Add tooltip from health data
            } else {
                // Default state if no health data found
                statusBadge.textContent = 'Unknown';
                statusBadge.className = 'status-badge offline';
                statusBadge.title = 'Health status unknown';
            }
        } else {
             console.warn("Could not extract trip code from card details:", detailsDiv.innerHTML);
             statusBadge.textContent = 'Error';
             statusBadge.className = 'status-badge offline';
             statusBadge.title = 'Could not identify trip code';
        }
    });
}


/**
 * Renders shuttle markers (car icons) on the map based on cluster data.
 * Includes conditional zooming logic.
 */
function renderShuttlesOnMap() {
    console.log("Rendering shuttles on map...");
    // Clear previous markers
    currentClusterMarkers.forEach(marker => map.removeLayer(marker));
    currentClusterMarkers = [];
    const markersToAdd = [];

    Object.values(clusters).forEach(cluster => {
        // Validate cluster data
        if (!cluster || !cluster.center || typeof cluster.center.lat !== 'number' || typeof cluster.center.lng !== 'number') {
            console.warn("Skipping invalid cluster data:", cluster); return;
        }
        // Calculate strength and color hue
        const strength = Math.min(1, Math.max(0, cluster.strength || 0));
        const strengthHue = strength * 120; // 0=red, 120=green

        // Create the custom DivIcon for the car
        const shuttleIcon = L.divIcon({
            className: 'shuttle-marker-container', // Main container class
            html: `<div class="shuttle-icon" style="color: hsl(${strengthHue}, 80%, 40%);"><i class="fas fa-car-side"></i><span class="shuttle-count" title="${cluster.riderCount} riders in cluster / ${cluster.totalRiders} total riders">${cluster.riderCount}</span></div>`,
            iconSize: [40, 40], iconAnchor: [20, 40], popupAnchor: [0, -40] // Anchors and popup position
        });

        // Create the Leaflet marker
        const marker = L.marker([cluster.center.lat, cluster.center.lng], {
            icon: shuttleIcon,
            title: `Shuttle: Trip ${cluster.tripCode} (${cluster.riderCount}/${cluster.totalRiders}, Strength: ${Math.round(strength * 100)}%)` // Tooltip on hover
        });

        // Create popup content
        const popupContent = `
            <div class="cluster-popup">
                <h4><i class="fas fa-bus"></i> Shuttle: Trip ${cluster.tripCode}</h4>
                <p><strong>Riders in Cluster:</strong> ${cluster.riderCount} / ${cluster.totalRiders}</p>
                <p><strong>Cluster Strength:</strong> ${Math.round(strength * 100)}%</p>
                <p><strong>Location:</strong> ${cluster.center.lat.toFixed(5)}, ${cluster.center.lng.toFixed(5)}</p>
                <p><strong>Last Calc:</strong> ${new Date(cluster.timestamp).toLocaleTimeString()}</p>
                ${cluster.riders && cluster.riders.length > 0 ? `<p><strong>Riders:</strong> ${cluster.riders.join(', ')}</p>` : '<p>No rider details available.</p>'}
            </div>`;
        marker.bindPopup(popupContent);

        markersToAdd.push(marker);
        marker.addTo(map); // Add marker directly to the map
    });

    currentClusterMarkers = markersToAdd; // Update global list
    console.log(`Rendered ${currentClusterMarkers.length} shuttle markers.`);

    // --- Conditional Zooming Logic ---
    const currentMarkerCount = currentClusterMarkers.length;
    // Fit bounds only if map is ready AND (it's the first render OR the count changed)
    if (mapInitialized && currentMarkerCount > 0 && (currentMarkerCount !== previousMarkerCount || previousMarkerCount === -1)) {
         console.log(`Cluster count changed (${previousMarkerCount} -> ${currentMarkerCount}). Fitting bounds.`);
         const group = L.featureGroup(currentClusterMarkers);
         if (group.getLayers().length > 0) {
             map.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 16 }); // Add padding & limit zoom
         }
    }
    previousMarkerCount = currentMarkerCount; // Update count for next check
}

/**
 * Updates the statistics in the map overlay.
 */
function updateStats() {
    const activeTrips = Object.keys(tripsData).length;
    // Calculate total riders across all trips in the current view
    const totalActiveRiders = Object.values(tripsData).reduce((sum, trip) => sum + trip.riderCount, 0);

    const activeTripsEl = document.getElementById('active-trips');
    const activeRidersEl = document.getElementById('active-riders');

    if (activeTripsEl) activeTripsEl.textContent = activeTrips;
    if (activeRidersEl) activeRidersEl.textContent = totalActiveRiders;
}

// --- User Actions ---

/**
 * Handles the "Create Trip" button click.
 */
async function createTrip() {
    const codeInput = document.getElementById('new-code');
    const tripCode = codeInput.value.trim().toUpperCase();
    if (!tripCode) {
        showNotification('error', 'Invalid Input', 'Please enter a valid trip code.');
        return;
    }
    console.log(`Attempting to create trip: ${tripCode}`);
    document.getElementById('map-loading').style.display = 'flex'; // Show loading
    try {
        const response = await fetch('/api/createTrip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripCode }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Failed to create trip (${response.status})`);

        codeInput.value = ''; // Clear input
        showNotification('success', 'Trip Created', `Trip ${tripCode} created successfully.`);
        generateTripQR(tripCode); // Add QR code to panel
        await pollTrips(); // Refresh trip list/count
        await pollAndRender(); // Refresh main data

    } catch (error) {
        console.error("Trip creation error:", error);
        showNotification('error', 'Trip Creation Failed', error.message);
    } finally {
        document.getElementById('map-loading').style.display = 'none'; // Hide loading
    }
}

/**
 * Handles the "Delete Trip" button click within a QR item.
 * @param {string} tripCode - The trip code to delete.
 * @param {HTMLElement} qrItemElement - The corresponding QR item element.
 */
async function deleteTrip(tripCode, qrItemElement) {
    if (!confirm(`Are you sure you want to delete Trip ${tripCode}? This will also remove all its rider data.`)) return;

    console.log(`Attempting to delete trip: ${tripCode}`);
    qrItemElement.style.opacity = '0.5'; // Visual feedback

    try {
        const response = await fetch('/api/deleteTrip', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripCode }) });
        const result = await response.json();
        if (!response.ok && response.status !== 404) { // Allow 404 if trip already gone
             throw new Error(result.message || `Failed to delete trip (${response.status})`);
        }

        qrItemElement.remove(); // Remove QR item from DOM
        showNotification('success', 'Trip Deleted', result.message || `Trip ${tripCode} deleted.`);

        // Check if any QR codes remain, show placeholder if not
        const qrContainer = document.getElementById('qrs');
        if (qrContainer && qrContainer.children.length === 0 && !qrContainer.querySelector('p.no-items')) {
            qrContainer.innerHTML = '<p class="no-items">No trips created yet.</p>';
        }

        await pollAndRender(); // Refresh trip panel
        await pollTrips(); // Refresh QR list & count

    } catch (error) {
        console.error("Trip deletion error:", error);
        showNotification('error', 'Deletion Failed', error.message);
        qrItemElement.style.opacity = '1'; // Restore opacity on failure
    }
}

/**
 * Handles the "Initialize Test Data" / "Load Sample Data" button click.
 */
async function initializeData() {
     if (!confirm('Initialize with sample data? This will clear existing data for sample trips IKI490 and ABX123.')) return;

    console.log("Initializing sample data...");
    document.getElementById('map-loading').style.display = 'flex'; // Show loading
    try {
        const response = await fetch('/api/initData', { method: 'POST' });
        if (!response.ok) throw new Error('Failed to initialize sample data');

        // Fetch and render all data after initialization
        await pollAndRender();
        await fetchClustersAndRender();
        await pollTrips();
        showNotification('success', 'Data Initialized', 'Sample trip data created.');
        const noDataMsg = document.getElementById('no-data-message');
        if(noDataMsg) noDataMsg.style.display = 'none'; // Hide "No Data" message

    } catch (error) {
        console.error("Data initialization error:", error);
        showNotification('error', 'Initialization Failed', error.message);
    } finally {
        document.getElementById('map-loading').style.display = 'none'; // Hide loading
    }
}

/**
 * Handles the "Reset All Data" button click.
 */
async function resetData() {
    if (!confirm('DANGER! Are you sure you want to reset ALL data? This will delete all trips and rider locations permanently.')) return;

    console.log("Resetting all data...");
    document.getElementById('map-loading').style.display = 'flex'; // Show loading
    try {
        const response = await fetch('/api/resetData', { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to reset data');

        // --- Clear Local State ---
        markerCluster.clearLayers(); // Clear any individual markers if used
        currentClusterMarkers.forEach(marker => map.removeLayer(marker)); // Clear shuttle markers
        currentClusterMarkers = [];
        clusters = {};
        tripsData = {};
        eventLog = [];
        lastEventTimestamp = 0;
        previousMarkerCount = -1; // Reset zoom tracker

        // --- Clear UI Elements ---
        const qrContainer = document.getElementById('qrs');
        const tripsList = document.getElementById('trips-list');
        if(qrContainer) qrContainer.innerHTML = '<p class="no-items">No trips created yet.</p>';
        if(tripsList) tripsList.innerHTML = '<p class="no-items">No active trips found.</p>';
        // Clear event log display if it exists

        updateStats(); // Reset stats display to zero
        showNotification('success', 'Data Reset', 'All trips and rider data have been deleted.');
        const noDataMsg = document.getElementById('no-data-message');
        if(noDataMsg) noDataMsg.style.display = 'flex'; // Show the 'no data' message

    } catch (error) {
        console.error("Data reset error:", error);
        showNotification('error', 'Reset Failed', error.message);
    } finally {
        document.getElementById('map-loading').style.display = 'none'; // Hide loading
    }
}

/**
 * Handles the "Refresh Data" button click.
 */
async function refreshData() {
    console.log("Manual refresh triggered.");
    showNotification('info', 'Refreshing...', 'Fetching latest data...');
    document.getElementById('map-loading').style.display = 'flex'; // Show loading
    // Fetch all data sources sequentially
    await pollAndRender();
    await fetchClustersAndRender();
    await fetchTripHealth();
    // await fetchEvents(); // If event log is used
    await pollTrips();
    document.getElementById('map-loading').style.display = 'none'; // Hide loading
    showNotification('success', 'Data Refreshed', 'Map and panel data updated.');
}

// --- QR Code Handling ---

/**
 * Generates and displays a QR code item in the panel.
 * Adds necessary class and data attributes for modal functionality.
 * @param {string} tripCode - The trip code.
 */
function generateTripQR(tripCode) {
    const qrContainer = document.getElementById('qrs');
    if (!qrContainer) return;
    const placeholder = qrContainer.querySelector('p.no-items');
    if (placeholder) placeholder.remove(); // Remove "No trips" message
    if (qrContainer.querySelector(`.qr-item[data-code="${tripCode}"]`)) return; // Skip if exists

    console.log(`Generating QR code for trip: ${tripCode}`);
    const qrItem = document.createElement('div');
    qrItem.className = 'qr-item';
    qrItem.setAttribute('data-code', tripCode);

    const baseUrl = window.location.origin;
    const mobileUrl = `${baseUrl}/mobile.html?code=${tripCode}`;
    // Use a smaller size for the panel display
    const qrCodeApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(mobileUrl)}`;

    qrItem.innerHTML = `
        <p>${tripCode}</p>
        <img class="qr-code-image" src="${qrCodeApiUrl}" alt="QR Code for ${tripCode}" title="Click to enlarge QR Code for ${tripCode}" data-mobile-url="${mobileUrl}" />
        <div class="actions-bar">
            <button class="btn btn-sm btn-secondary trip-download" title="Download QR">
                <i class="fas fa-download"></i>
            </button>
            <button class="btn btn-sm btn-danger trip-delete" title="Delete Trip">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    `;
    qrContainer.appendChild(qrItem);
}

/**
 * Sets up a single event listener on the QR container for delegation.
 * Handles clicks for download, delete, and enlarging the QR code.
 */
function setupQRActionsListener() {
    if (qrActionListenerAdded) return; // Prevent adding multiple listeners
    const qrContainer = document.getElementById('qrs');
    if (!qrContainer) return;

    qrContainer.addEventListener('click', (event) => {
        const downloadBtn = event.target.closest('.trip-download');
        const deleteBtn = event.target.closest('.trip-delete');
        const qrImage = event.target.closest('.qr-code-image'); // Check if image was clicked
        const qrItem = event.target.closest('.qr-item');

        if (!qrItem) return; // Ignore clicks outside QR items
        const tripCode = qrItem.dataset.code;
        const imgElement = qrItem.querySelector('img.qr-code-image'); // Find the image element

        if (downloadBtn && tripCode && imgElement) {
            downloadQR(tripCode, imgElement.src);
        } else if (deleteBtn && tripCode) {
            deleteTrip(tripCode, qrItem);
        } else if (qrImage && tripCode && imgElement) { // If the image itself was clicked
             showQrModal(tripCode, imgElement.src, imgElement.dataset.mobileUrl);
        }
    });
    qrActionListenerAdded = true;
    console.log("QR action listener added (including modal trigger).");
}

/**
 * Updates the QR code display section, adding new QRs and removing stale ones.
 * @param {Array} trips - Array of trip objects {code, ...}.
 */
function updateQRCodes(trips) {
    const qrContainer = document.getElementById('qrs');
    if (!qrContainer) return;
    setupQRActionsListener(); // Ensure the listener is attached

    const existingServerCodes = new Set(trips.map(trip => trip.code));

    // Add QRs for trips from server that aren't displayed yet
    trips.forEach(trip => {
        if (!qrContainer.querySelector(`.qr-item[data-code="${trip.code}"]`)) {
            generateTripQR(trip.code);
        }
    });

    // Remove QRs from display if the trip code is no longer in the server list
    const displayedQRs = qrContainer.querySelectorAll('.qr-item');
    displayedQRs.forEach(qrItem => {
        const tripCode = qrItem.dataset.code;
        if (!existingServerCodes.has(tripCode)) {
            console.log(`Removing stale QR code for deleted trip: ${tripCode}`);
            qrItem.remove();
        }
    });

     // Update placeholder visibility
     if (qrContainer.children.length === 0 && !qrContainer.querySelector('p.no-items')) {
         qrContainer.innerHTML = '<p class="no-items">No trips created yet.</p>';
     } else if (qrContainer.children.length > 0) {
         const placeholder = qrContainer.querySelector('p.no-items');
         if(placeholder) placeholder.remove();
     }
}

/**
 * Initiates the download of a QR code image using fetch.
 * @param {string} tripCode - The trip code for the filename.
 * @param {string} qrImageUrl - The URL of the QR image.
 */
function downloadQR(tripCode, qrImageUrl) {
    console.log(`Downloading QR for ${tripCode}`);
    const link = document.createElement('a');
    fetch(qrImageUrl)
        .then(response => { if (!response.ok) throw new Error(`HTTP error ${response.status}`); return response.blob(); })
        .then(blob => {
            const objectUrl = URL.createObjectURL(blob);
            link.href = objectUrl; link.download = `trip-${tripCode}-qr.png`;
            document.body.appendChild(link); link.click(); document.body.removeChild(link);
            URL.revokeObjectURL(objectUrl); // Clean up blob URL
            showNotification('success', 'QR Download', `QR code download started for Trip ${tripCode}.`);
        })
        .catch(error => { console.error('QR Code download error:', error); showNotification('error', 'Download Failed', `Could not download QR code: ${error.message}`); });
}

// --- QR Modal Functions ---

/**
 * Populates and displays the QR code modal.
 * @param {string} tripCode - The trip code to display.
 * @param {string} qrImageUrl - The URL of the QR image (small version).
 * @param {string} mobileUrl - The URL the QR code points to.
 */
function showQrModal(tripCode, qrImageUrl, mobileUrl) {
    const modal = document.getElementById('qr-modal');
    const modalImage = document.getElementById('modal-qr-image');
    const modalTitle = document.getElementById('modal-trip-code');
    const modalLink = document.getElementById('modal-qr-link');

    if (modal && modalImage && modalTitle && modalLink) {
        modalTitle.textContent = `Trip Code: ${tripCode}`;
        // Request a larger QR code image for the modal display
        modalImage.src = qrImageUrl.replace('size=120x120', 'size=300x300');
        modalImage.alt = `Enlarged QR Code for ${tripCode}`;
        modalLink.href = mobileUrl; // Set the link URL

        modal.style.display = 'flex'; // Make overlay visible
        // Add 'show' class shortly after to trigger CSS transition/animation
        requestAnimationFrame(() => {
             modal.classList.add('show');
        });
        console.log(`Showing QR modal for ${tripCode}`);
    } else {
        console.error("QR Modal elements not found!");
    }
}

/**
 * Hides the QR code modal with animation.
 */
function hideQrModal() {
    const modal = document.getElementById('qr-modal');
    if (modal) {
         modal.classList.remove('show'); // Remove 'show' to trigger fade/scale out
         // Wait for CSS transition to finish before setting display: none
         setTimeout(() => {
             modal.style.display = 'none';
             // Clear image src to prevent brief flash of old QR next time
             const modalImage = document.getElementById('modal-qr-image');
             if(modalImage) modalImage.src = "";
         }, 300); // Should match modal transition duration in CSS
        console.log("Hiding QR modal");
    }
}

// --- Utility Functions ---

/**
 * Displays a temporary notification message.
 * @param {'success'|'error'|'warning'|'info'} type - Notification type.
 * @param {string} title - Notification title.
 * @param {string} message - Notification message.
 */
function showNotification(type, title, message) {
    const notificationsArea = document.getElementById('notifications');
    if (!notificationsArea) return;

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`; // Base and type-specific class

    // Determine icon based on type
    let icon = 'info-circle';
    if (type === 'success') icon = 'check-circle';
    else if (type === 'error') icon = 'exclamation-triangle';
    else if (type === 'warning') icon = 'exclamation-circle';

    // Build notification HTML
    notification.innerHTML = `
        <div class="notification-icon"><i class="fas fa-${icon}"></i></div>
        <div class="notification-content">
            <div class="notification-title">${title}</div>
            <div class="notification-message">${message}</div>
        </div>
        <button class="notification-close">&times;</button>
    `;

    // --- Close logic ---
    const closeBtn = notification.querySelector('.notification-close');
    let isClosing = false; // Prevent multiple close triggers
    const closeNotification = () => {
        if (isClosing) return;
        isClosing = true;
        clearTimeout(timeoutId); // Clear auto-remove timer
        notification.classList.remove('show'); // Trigger fade-out animation
        // Remove from DOM after animation
        setTimeout(() => {
            if (notificationsArea.contains(notification)) {
                notificationsArea.removeChild(notification);
            }
        }, 300); // Match CSS transition duration
    };

    closeBtn.addEventListener('click', closeNotification);

    // --- Auto-remove logic ---
    const timeoutId = setTimeout(closeNotification, 5000); // Auto-close after 5 seconds

    // Add to DOM and trigger animation
    notificationsArea.appendChild(notification);
    requestAnimationFrame(() => {
        notification.classList.add('show');
    });
}

/**
 * Converts a date/timestamp into a relative time string (e.g., "5m ago").
 * @param {Date|string} date - The date to format.
 * @returns {string} - The relative time string.
 */
function getTimeAgo(date) {
    if (!date) return 'unknown time';
    const dateObj = typeof date === 'string' ? new Date(date) : date;
     if (isNaN(dateObj.getTime())) return 'invalid date';

    const seconds = Math.floor((new Date() - dateObj) / 1000);

    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 120) return '1m ago';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 7200) return '1h ago';
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    // Fallback for older dates
    return dateObj.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}


// --- App Entry Point ---
window.addEventListener('load', init); // Start the app when the page is loaded
