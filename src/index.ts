// import dotenv from "dotenv";
// // Load up env file which contains credentials
// dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

// import { Server } from "./server";

// const server = new Server();
// server.listen(8080);
import dotenv from "dotenv";
// Load up env file which contains credentials
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

import { Server } from "./server";

const server = new Server();

// Check for Render's dynamic system port, otherwise fall back to 8080
const port = process.env.PORT || 8080;

server.listen(Number(port));
console.log(`Voice server successfully listening on port ${port}`);
