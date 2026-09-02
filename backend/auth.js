import express from "express";
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FRONTEND_PATH = path.join(__dirname, "..", "frontend", "homepage.html");
const HOME_PATH = "/";
const DEFAULT_CALLBACK_URL = "http://localhost:10000/auth/github/callback";

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_CALLBACK_URL =process.env.GITHUB_CALLBACK_URL || DEFAULT_CALLBACK_URL;

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user || null);
});

passport.use(
  new GitHubStrategy(
    {
      clientID: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
      callbackURL: GITHUB_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const profileJson = profile?._json || {};

        const email =
          profile?.emails?.find((entry) => entry?.value)?.value ||
          profileJson.email ||
          null;

        const user = {
          provider: "github",
          githubId: String(profile.id),
          login: profile.username || profileJson.login || null,
          name:
            profile.displayName ||
            profileJson.name ||
            profile.username ||
            profileJson.login ||
            "GitHub User",
          email,
          photoURL: profile.photos?.[0]?.value || profileJson.avatar_url || null,
          profileURL: profile.profileUrl || profileJson.html_url || null,
          githubUrl: profileJson.html_url || profile.profileUrl || null,

          /* Server-side only credentials. */
          accessToken,
          refreshToken: refreshToken || null,

          lastLoginAt: new Date().toISOString(),
        };

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);


router.get("/", (req, res) => {
  return res.sendFile(FRONTEND_PATH);
});

router.post("/", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({
      authenticated: true,
      redirectUrl: "/"
    });
  }

  return res.json({
    authenticated: false,
    redirectUrl: "/auth/github"
  });
});

router.get("/github", (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.redirect(HOME_PATH);
  }

  return passport.authenticate("github", {
    scope: ["read:user", "user:email", "repo"],
  })(req, res, next);
});

/* ============================================================
   GET /auth/github/callback
   ============================================================ */

router.get(
  "/github/callback",
  passport.authenticate("github", {
    failureRedirect: "/?githubAuth=failed",
    session: true,
  }),
  (req, res, next) => {
    /* Ensure the Mongo-backed session is written before redirecting. */
    if (!req.session || typeof req.session.save !== "function") {
      return res.redirect(HOME_PATH);
    }

    req.session.save((error) => {
      if (error) return next(error);
      return res.redirect(HOME_PATH);
    });
  }
);



/* ============================================================
   POST /logout
   ============================================================ */

router.post("/logout", (req, res, next) => {
  const finishLogout = () => {
    if (req.session) {
      return req.session.destroy((sessionError) => {
        if (sessionError) return next(sessionError);

        res.clearCookie(process.env.SESSION_NAME || "session");
        res.clearCookie("connect.sid");

        return res.status(200).json({
          ok: true,
          authenticated: false,
        });
      });
    }

    return res.status(200).json({
      ok: true,
      authenticated: false,
    });
  };

  if (typeof req.logout !== "function") {
    return finishLogout();
  }

  return req.logout((error) => {
    if (error) return next(error);
    return finishLogout();
  });
});

/* ============================================================
   SAFE USER SHAPE FOR THE FRONTEND
   ============================================================ */

function getPublicUser(user) {
  return {
    provider: "github",
    githubId: user?.githubId || null,
    login: user?.login || null,
    name: user?.name || "GitHub User",
    email: user?.email || null,
    photoURL: user?.photoURL || null,
    profileURL: user?.profileURL || user?.githubUrl || null,
  };
}

export default router;
