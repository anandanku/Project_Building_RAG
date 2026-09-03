import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import session from "express-session";
import passport from "passport";
import MongoStore from "connect-mongo";
import path from "path";
import { fileURLToPath } from "url";

import authRouter from "./auth.js";
import apiRouter from "./api.js";
import chatRouter from "./chat.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "frontend")));

mongoose
  .connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME,
  })
  .then(() => console.log("MongoDB Connected"))
  .catch((error) => console.error("MongoDB Connection Error:", error));

app.use(
  session({
    name: process.env.SESSION_NAME || "session",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      dbName: process.env.MONGO_DB_NAME,
      collectionName: "sessions",
    }),
    cookie: {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: parseInt(
        process.env.SESSION_MAX_AGE || "86400000",
        10
      ),
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

/* ============================= */
/* ROUTERS */
/* ============================= */

app.use("/", authRouter);
app.use("/auth", authRouter);
app.use("/api", apiRouter);
app.use("/api/rag", chatRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
