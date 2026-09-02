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
const GITHUB_CALLBACK_URL =
  process.env.GITHUB_CALLBACK_URL || DEFAULT_CALLBACK_URL;

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.warn(
    "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env."
  );
}

/* ============================================================
   PASSPORT SESSION
   ============================================================

   The GitHub access token stays server-side inside the Passport
   session. It is NEVER returned by /auth/me to the browser.

   The token is kept because Sensei will use the authenticated
   user's GitHub permissions later when reading repositories and
   repository files.
*/

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user || null);
});

/* ============================================================
   GITHUB OAUTH STRATEGY
   ============================================================ */

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

/* ============================================================
   ROOT / HOME
   ============================================================

   GitHub sends the user back to /. The frontend then calls
   GET /auth/me to obtain the safe user information it needs.
*/

router.get("/", (req, res) => {
  return res.sendFile(FRONTEND_PATH);
});

/* ============================================================
   POST /auth
   ============================================================

   Sensei's current homepage calls POST /auth when the user clicks
   "Connect GitHub".

   A normal browser OAuth flow cannot be completed inside fetch(),
   so this endpoint returns the OAuth URL instead of trying to
   navigate the fetch request itself.

   If the user is already authenticated, no new OAuth flow starts.
   The endpoint returns the safe frontend user data and redirects
   the frontend to /.
*/

router.post("/", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.status(200).json({
      authenticated: true,
      redirectUrl: HOME_PATH,
      user: getPublicUser(req.user),
    });
  }

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res.status(500).json({
      authenticated: false,
      error: "GitHub OAuth is not configured on the server.",
    });
  }

  return res.status(200).json({
    authenticated: false,
    redirectUrl: "/auth/github",
  });
});

/* ============================================================
   GET /auth/github
   ============================================================

   Starts the actual Passport GitHub OAuth flow.
*/

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
   GET /auth/me
   ============================================================

   This is the endpoint consumed by Sensei's homepage.

   NEVER return accessToken/refreshToken here.
*/

router.get("/me", (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({
      authenticated: false,
      user: null,
    });
  }

  return res.status(200).json({
    authenticated: true,
    user: getPublicUser(req.user),
  });
});

/* ============================================================
   GET /auth/github/token-status

   Internal-friendly endpoint for checking whether Sensei has a
   GitHub token in the current session without exposing it.
   ============================================================ */

router.get("/github/token-status", (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ authenticated: false, connected: false });
  }

  return res.status(200).json({
    authenticated: true,
    connected: Boolean(req.user.accessToken),
    githubId: req.user.githubId || null,
    login: req.user.login || null,
  });
});

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
