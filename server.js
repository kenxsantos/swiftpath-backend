const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");

// Initialize Express App
const app = express();
const PORT = 3000;

// Parse incoming JSON
app.use(bodyParser.json());

// Initialize Firebase Admin SDK
const serviceAccount = require("./firebase-service-account.json"); // Replace with your Firebase service account key
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Webhook endpoint for Roam.ai
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body; // Assume the payload is a single event
    console.log("Received event:", event); // Log the payload for debugging

    if (!event || event.event_type !== "geospark:geofence:entry") {
      return res.status(400).send("Invalid payload");
    }

    const notification = {
      notification: {
        title: "Geofence Entry",
        body: `User ${event.user_id} entered geofence ${event.geofence_id}: ${
          event.description || ""
        }`,
      },
      data: {
        user_id: event.user_id,
        geofence_id: event.geofence_id,
        description: event.description || "",
        coordinates: JSON.stringify(event.location.coordinates),
      },
      topic: "geofence_notifications",
    };

    // Send notification using Firebase Cloud Messaging
    await admin.messaging().send(notification);

    res.status(200).send("Event processed");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal server error");
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
