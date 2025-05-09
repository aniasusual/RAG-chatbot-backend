import app from "./app.js"
// const cloudinary = require("cloudinary");
import { connectDatabase } from "./config/database.js";
import bodyParser from "body-parser";
import { config } from "dotenv";

if (process.env.NODE_ENV !== "production") {
    config({ path: "config/config.env" });
}

// Handling Uncaught Exception
process.on("uncaughtException", (err) => {
    console.log(`Error: ${err.message}`);
    console.log(`Shutting down the server due to Uncaught Exception`);
    process.exit(1);
});


// app.use(
//     bodyParser.json({
//         verify: function (req, res, buf) {
//             req.rawBody = buf;
//         }
//     })
// );

app.use(bodyParser.json());

// connectDatabase();


const server = app.listen(process.env.PORT, () => {
    console.log(`Server is working on http://localhost:${process.env.PORT}`);
});

// Unhandled Promise Rejection
process.on("unhandledRejection", (err) => {
    console.log(`Error: ${err.message}`);
    console.log(`Shutting down the server due to Unhandled Promise Rejection`);

    server.close(() => {
        process.exit(1);
    });
});