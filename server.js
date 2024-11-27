const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const http = require("http"); // Import missing http module
const socketIo = require("socket.io");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

// Initialize Express App
const app = express();
const PORT = 3000;
const server = http.createServer(app); // Use HTTP server to support WebSocket
const io = socketIo(server, {
  path: "/webhook", // Match Flutter's path
  transports: ["websocket"],
});

// Initialize Firebase Admin SDK
const serviceAccount = require("./firebase-service-account.json"); // Replace with your Firebase service account key
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://swiftpath-77a56-default-rtdb.firebaseio.com/",
});

const db = admin.database();

// Your Roam.ai API key
const ROAM_API_KEY = process.env.ROAM_API_KEY;

let currentCoordinates = null;
let destinationCoordinates = null;
let vehicleLocation = {};

// Parse incoming JSON
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(bodyParser.json());

app.post("/report-incident", async (req, res) => {
  console.log(`Test: ${req.body}`);

  const {
    latitude,
    longitude,
    status,
    address,
    details,
    reporter_email,
    reporter_name,
    timestamp,
    image_url,
  } = req.body;

  try {
    const geofenceId = await createGeofence(latitude, longitude);
    if (geofenceId) {
      await storeIncidentReport(
        latitude,
        longitude,
        status,
        reporter_email,
        reporter_name,
        timestamp,
        image_url,
        geofenceId,
        address,
        details
      );

      res.status(200).json({ message: "Incident reported successfully." });
    } else {
      res.status(500).json({ message: "Failed to create geofence." });
    }
  } catch (error) {
    console.error("Error handling incident report:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/current-location", async (req, res) => {
  try {
    const destination = req.body.destination;
    const origin = req.body.origin;

    if (!destination || !origin) {
      return res.status(400).send("Invalid destination payload");
    }

    destinationCoordinates = destination;
    currentCoordinates = origin;
    console.log(
      "Destination received:",
      destinationCoordinates,
      currentCoordinates
    );
    res
      .status(200)
      .send(
        "Location received successfully. Calculating routes to destination..."
      );
    await requestRoutes();
  } catch (error) {
    console.error("Error handling destination:", error);
    res.status(500).send("Error processing destination");
  }
});

async function createGeofence(latitude, longitude) {
  try {
    const now = new Date();
    const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day later
    const geofenceData = {
      coordinates: [longitude, latitude],
      geometry_radius: 500,
      description: "Incident Location",
      tag: "Incident Report",
      metadata: {},
      is_enabled: [true, now.toISOString(), endTime.toISOString()],
    };

    const response = await axios.post(
      "https://api.roam.ai/v1/api/geofence/",
      geofenceData,
      {
        headers: {
          "Api-Key": ROAM_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.status === 201) {
      const geofenceId = response.data.data.geofence_id;
      console.log("Geofence created successfully:", geofenceId);
      return geofenceId;
    } else {
      console.error("Failed to create geofence:", response.data);
      return null;
    }
  } catch (error) {
    console.error("Error creating geofence:", error);
    return null;
  }
}

async function storeIncidentReport(
  latitude,
  longitude,
  status,
  reporter_email,
  reporter_name,
  timestamp,
  image_url,
  geofenceId,
  address,
  details
) {
  try {
    const incidentData = {
      geofence_id: geofenceId,
      image_url: image_url,
      latitude: latitude,
      longitude: longitude,
      address: address,
      details: details,
      reporter_name: reporter_name,
      reporter_email: reporter_email,
      status: status,
      timestamp: timestamp,
    };

    await db.ref(`incident-reports/`).push(incidentData);
    console.log("Incident stored successfully.");
  } catch (error) {
    console.error("Error storing incident:", error);
    throw error;
  }
}

app.post("/emergency-vehicle-location", async (req, res) => {
  try {
    const { origin, userId, is_tracking } = req.body;

    // Check if the required parameters are provided
    if (!userId || !origin) {
      return res.status(400).send("Invalid destination payload");
    }

    console.log(
      "Received location for userId:",
      userId,
      "Location:",
      origin,
      "is_tracking:",
      is_tracking
    );

    const ref = db.ref("emergency-vehicle-location");

    // First, check if the userId already exists in the database
    ref.child(userId).once("value", (snapshot) => {
      if (snapshot.exists()) {
        // User exists, update their location
        ref.child(userId).update(
          {
            origin: origin,
            is_tracking: is_tracking,
          },
          (error) => {
            if (error) {
              console.log("Error updating data in Firebase:", error);
              res.status(500).send("Error updating location");
            } else {
              console.log("Location updated successfully for userId:", userId);
              res.status(200).send("Location updated successfully");
            }
          }
        );
      } else {
        // User does not exist, create a new entry
        const emergencyVehicleData = {
          [userId]: {
            origin: origin,
            is_tracking: is_tracking,
            userId: userId,
          },
        };

        // Set the new user data
        ref.update(emergencyVehicleData, (error) => {
          if (error) {
            console.log("Error writing data to Firebase:", error);
            res.status(500).send("Error adding new location");
          } else {
            console.log(
              "New emergency vehicle data added successfully for userId:",
              userId
            );
            res.status(200).send("New location added successfully");
          }
        });
      }
    });
  } catch (error) {
    console.error("Error handling location:", error);
    res.status(500).send("Error processing location");
  }
});

async function requestRoutes() {
  try {
    if (!currentCoordinates || !destinationCoordinates) {
      console.log(
        `Current coordinates ${currentCoordinates} or destination coordinates ${destinationCoordinates} are not available.`
      );
      console.log(
        "Current coordinates or destination coordinates are not available."
      );
      return;
    }

    // Prepare the destination coordinates directly from parameters
    let destination = destinationCoordinates;
    let origin = currentCoordinates;

    const apiKey = "AIzaSyC2cU6RHwIR6JskX2GHe-Pwv1VepIHkLCg"; // Replace with your Google Maps API key
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&alternatives=true&key=${apiKey}`;

    // Send request to Google Directions API
    const response = await axios.get(url);
    const directionsData = response.data;

    if (directionsData.status === "OK") {
      const routes = directionsData.routes.map((route) => ({
        summary: route.summary,
        distance: route.legs[0]?.distance?.text || "",
        duration: route.legs[0]?.duration?.text || "",
        start_address: route.legs[0]?.start_address || "",
        end_address: route.legs[0]?.end_address || "",
        steps:
          route.legs[0]?.steps.map((step) => ({
            instruction: step.html_instructions,
            distance: step.distance?.text || "",
            duration: step.duration?.text || "",
            polyline: step.polyline?.points || "",
          })) || [],
        overview_polyline: route.overview_polyline?.points || "",
      }));

      // Emit the routes to connected clients via WebSocket
      io.emit("alternative_routes", { routes });
      console.log("Alternative routes emitted successfully.");
      console.log("Routes:", routes);
    } else {
      console.error("Error fetching directions:", directionsData.error_message);
    }
  } catch (error) {
    console.error("Error fetching and emitting routes:", error);
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [req.body]; // Handle both wrapped events and single event
    console.log("Received events:", events);

    if (!events || (!Array.isArray(events) && !events.event_type)) {
      return res.status(400).send("Invalid payload");
    }

    for (const event of events) {
      let notification = {
        notification: {
          title: "Event Notification",
          body: "An event has been recorded.",
        },
        data: {},
        topic: "default_notifications",
      };

      if (!event || !event.event_type) {
        continue; // Skip invalid events
      }

      // Process different event types
      switch (event.event_type) {
        case "geospark:moving-geofence:nearby":
          notification = {
            notification: {
              title: "An Emergency Vehicle is approaching!",
              body: `Please make way for the emergency vehicle.`,
            },
            data: {
              user_id: event.user_id,
              location_id: event.location_id,
            },
            topic: "moving_geofence_nearby_notifications",
          };
          io.emit("moving_geofence_update", {
            location_id: event.location_id,
            nearby_user_id: event.nearby_user_id,
            recorded_at: event.recorded_at,
            location: event.location,
          });
          break;
        case "geospark:geofence:entry":
          notification = {
            notification: {
              title: "You have entered the incident area!",
              body: `Take Alternate Route to avoid traffic congestion.`,
            },
            data: {
              user_id: event.user_id,
              location_id: event.location_id,
            },
            topic: "geofence_entry_notifications",
          };
          io.emit("geofence_update", {
            location_id: event.location_id,
            geofence_id: event.geofence_id,
            recorded_at: event.recorded_at,
            location: event.location,
          });
          await requestRoutes();
          break;
        case "geospark:geofence:Exit":
          notification = {
            notification: {
              title: "Geofence Exit",
              body: `You have exited the incident area!`,
            },
            data: {
              user_id: event.user_id,
              location_id: event.location_id,
            },
            topic: "geofence_exit_notifications",
          };
          break;
        case "geospark:geofence:dwell":
          notification = {
            notification: {
              title: "Geofence Dwell",
              body: `User ${event.user_id} dwell geofence ${event.geofence_id}.`,
            },
            topic: "geofence_dwell_notifications",
          };
          break;
        case "geospark:location:point":
          currentCoordinates = event.coordinates;
          io.emit("location_update", { coordinates: currentCoordinates }); // Emit the updated coordinates
          notification = {
            notification: {
              title: "Location Update",
              body: `User ${event.user_id} updated their location.`,
            },
            data: {
              user_id: event.user_id,
              location_id: event.location_id,
              coordinates: JSON.stringify(event.coordinates),
            },
            topic: "location_change_notifications",
          };
          // await requestRoutes();
          break;
        default:
          console.log("Unhandled event type:", event.event_type);
          continue;
      }

      // Send notification using Firebase Cloud Messaging
      await admin.messaging().send(notification);
    }

    res.status(200).send("Event processed");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal server error");
  }
});

// WebSocket Connection for WebSocket
io.on("connection", (socket) => {
  try {
    console.log("A user connected");

    // Send the current coordinates to the newly connected client
    if (currentCoordinates) {
      socket.emit("location_update", currentCoordinates); // Emit initial coordinates
    }

    socket.on("disconnect", () => {
      console.log("User disconnected");
    });
  } catch (error) {
    console.error("Error handling socket connection:", error);
  }
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
