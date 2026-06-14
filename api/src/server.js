const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});
app.use((req, _res, next) => {
    if (req.url.startsWith("/api/")) {
        req.url = req.url.replace("/api", "");
    } else if (req.url === "/api") {
        req.url = "/";
    }
    next();
});

const port = Number(process.env.API_PORT || 8080);

const events = [
    { id: "evt-1001", name: "DevSecOps Bootcamp", location: "Zagreb", availableTickets: 150 },
    { id: "evt-1002", name: "Cloud Native Day", location: "Split", availableTickets: 200 },
    { id: "evt-1003", name: "Security Engineering Meetup", location: "Rijeka", availableTickets: 90 }
];

const pgPool = new Pool({
    host: process.env.POSTGRES_HOST || "postgres",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "ticketing",
    user: process.env.POSTGRES_USER || "ticketing_user",
    password: process.env.POSTGRES_PASSWORD || "change_me_local"
});

const redisClient = createClient({
    socket: {
        host: process.env.REDIS_HOST || "redis",
        port: Number(process.env.REDIS_PORT || 6379)
    }
});

const queueName = process.env.QUEUE_NAME || "ticket_orders";

async function connectRedis() {
    redisClient.on("error", (error) => {
        console.error("Redis error:", error.message);
    });

    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
}

app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "okay", service: "api" });
});

app.get("/readyz", async (_req, res) => {
    try {
        await pgPool.query("SELECT 1");
        await redisClient.ping();
        return res.status(200).json({ status: "ready" });
    } catch (error) {
        return res.status(503).json({ status: "not-ready", error: error.message });
    }
});

app.get("/events", (_req, res) => {
    res.status(200).json(events);
});

app.post("/tickets/purchase", async (req, res) => {
    const { eventId, customerEmail, quantity } = req.body;

    if (!eventId || !customerEmail || !quantity) {
        return res.status(400).json({ error: "eventId, customerEmail and quantity are required" });
    }

    const selectedEvent = events.find((event) => event.id === eventId);
    if (!selectedEvent) {
        return res.status(404).json({ error: "Event not found" });
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: "quantity must be a positive integer" });
    }

    const order = {
        orderId: uuidv4(),
        eventId,
        customerEmail,
        quantity,
        status: "queued",
        createdAt: new Date().toISOString()
    };

    try {
        await redisClient.lPush(queueName, JSON.stringify(order));
        return res.status(202).json({ message: "Order queued", orderId: order.orderId });
    } catch (error) {
        return res.status(500).json({ error: "Unable to enqueue order", details: error.message });
    }
});

app.get("/tickets/orders", async (_req, res) => {
    try {
        const result = await pgPool.query(
            "SELECT order_id, event_id, customer_email, quantity, status, created_at FROM ticket_orders ORDER BY created_at DESC LIMIT 50"
        );
        return res.status(200).json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Unable to read orders", details: error.message });
    }
});

connectRedis()
    .then(() => {
        app.listen(port, () => {
            console.log(`API listening on port ${port}`);
        });
    })
    .catch((error) => {
        console.error("Failed to start API:", error);
        process.exit(1);
    });

process.on("SIGTERM", async () => {
    await pgPool.end();
    if (redisClient.isOpen) {
        await redisClient.quit();
    }
    process.exit(0);
});
