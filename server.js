const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const http = require("http"); // Import missing http module
const socketIo = require("socket.io");
const cors = require("cors");

// Initialize Express App
const app = express();
const PORT = 3000;
const server = http.createServer(app); // Use HTTP server to support WebSocket
const io = socketIo(server, {
  transports: ["websocket"], // Ensure WebSocket transport is enabled
});
// Initialize Firebase Admin SDK
const serviceAccount = require("./firebase-service-account.json"); // Replace with your Firebase service account key
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

let currentCoordinates = null;

// Parse incoming JSON
app.use(cors());
app.use(bodyParser.json());
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [req.body]; // Handle both wrapped events and single event
    console.log("Received events:", events); // Log the payload for debugging

    if (!events || (!Array.isArray(events) && !events.event_type)) {
      return res.status(400).send("Invalid payload");
    }

    // Process events
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
              title: "Geofence Enter",
              body: `User ${event.user_id} entered geofence ${event.geofence_id}.`,
            },
            topic: "geofence_notifications",
          };
          break;
        case "geospark:geofence:exit":
          notification = {
            notification: {
              title: "Geofence Exit",
              body: `User ${event.user_id} exited geofence ${event.geofence_id}.`,
            },
            topic: "geofence_notifications",
          };
          break;
        case "geospark:location:point":
          const currentCoordinates = event.coordinates; // Save latest coordinates
          console.log("Updated coordinates:", currentCoordinates);
          io.emit("location_update", currentCoordinates); // Emit updated coordinates to all connected clients
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
            topic: "location_notifications",
          };
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

// Webhook endpoint for Roam.ai

// Socket.IO Connection for WebSocket
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
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal server error");
    console.error("Detailed error:", error.stack); // Add more details for debugging
  }
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
