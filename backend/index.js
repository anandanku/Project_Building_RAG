import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import session from "express-session";
import passport from "passport";
import MongoStore from "connect-mongo";
import path from "path";
import { fileURLToPath } from "url";

/* ENV */
dotenv.config();

/* PATH FIX FOR ES MODULES */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* EXPRESS APP */
const app = express();

/* BODY PARSER */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* STATIC FRONTEND */
app.use(express.static(path.join(__dirname)));

/* ============================= */
/* MONGODB CONNECTION (ATLAS) */
/* ============================= */

mongoose
  .connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME,
  })
  .then(() => {
    console.log("MongoDB Connected");
  })
  .catch((err) => {
    console.error("MongoDB Connection Error:", err);
  });

/* ============================= */
/* SESSION CONFIGURATION */
/* ============================= */

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
      maxAge: parseInt(process.env.SESSION_MAX_AGE || "86400000"),
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());


app.use("/",authRouter);
app.use("/auth",authRouter)
