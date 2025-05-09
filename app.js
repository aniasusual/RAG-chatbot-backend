import express from 'express'
import errorMiddleware from "./middleware/error.js"
import dataRouter from './routes/dataRoute.js';
import { config } from "dotenv";
import session from 'express-session';

if (process.env.NODE_ENV !== "production") {
    config({ path: "config/config.env" });
}
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';



export const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.connect().catch((err) => {
    console.error('Failed to connect to Redis:', err);
    process.exit(1);
});


const app = express();
app.use(express.json());
app.use(
    session({
        store: new RedisStore({ client: redisClient }),
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === 'production', // Secure in production (requires HTTPS)
            maxAge: 24 * 60 * 60 * 1000, // 1 day
        },
    })
);

app.use("/api/v1/data", dataRouter)

app.use(errorMiddleware);

export default app;