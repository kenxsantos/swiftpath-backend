const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const http = require("http"); // Import missing http module
const socketIo = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const dotenv = require("dotenv");

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
});

let currentCoordinates = null;
let destinationCoordinates = null;

// Parse incoming JSON
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

app.post("/destination", async (req, res) => {
  try {
    const destination = req.body.destination;

    if (!destination || !destination.lat || !destination.lng) {
      return res.status(400).send("Invalid destination payload");
    }

    // Store the destination coordinates
    destinationCoordinates = destination;
    console.log("Destination received:", destinationCoordinates);

    res.status(200).send("Destination received successfully");
  } catch (error) {
    console.error("Error handling destination:", error);
    res.status(500).send("Error processing destination");
  }
});

async function requestRoutes() {
  try {
    if (!currentCoordinates || !destinationCoordinates) {
      console.log(
        "Current coordinates or destination coordinates are not available."
      );
      return;
    }
    // Prepare the destination coordinates directly from parameters
    let destination = destinationCoordinates;
    const originLat = currentCoordinates.coordinates[1]; // Latitude is the second element in the coordinates array
    const originLng = currentCoordinates.coordinates[0];

    const apiKey = process.env.GOOGLE_MAPS_API_KEY; // Replace with your Google Maps API key
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originLat},${originLng}&destination=${destination.lat},${destination.lng}&alternatives=true&key=${apiKey}`;

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
          await requestRoutes();
          break;
        default:
          console.log("Unhandled event type:", event.event_type);
          continue; // Skip unhandled event types
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
