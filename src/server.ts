import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import { check as portUsed } from "tcp-port-used";
import helmet from "helmet";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import k from "kleur";
import cors from "cors";

import packageJson from "../package.json";
import { error } from "./error";
import { initRouter } from "./routes";
import { respond } from "./utils";

const app = express();

app.use(cors({ methods: "GET,HEAD,OPTIONS", origin: "*" }));
app.use(helmet());
app.use(express.json());
app.use(compression());

app.disable("x-powered-by");

const rateLimiter = new RateLimiterMemory({
    points: 10,
    duration: 30,
});

const authTokens = getAuthTokens();

export async function init()
{
    const port = parseInt(String(process.env.HTTP_PORT ?? "").trim());
    const hostRaw = String(process.env.HTTP_HOST ?? "").trim();
    const host = hostRaw.length < 1 ? "0.0.0.0" : hostRaw;

    if(await portUsed(port))
        return error(`TCP port ${port} is already used or invalid`, undefined, true);

    // on error
    app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
        if(typeof err === "string" || err instanceof Error)
            return respond(res, "serverError", `General error in HTTP server: ${err.toString()}`, req?.query?.format ? String(req.query.format) : undefined);
        else
            return next();
    });

    // rate limiting
    app.use(async (req, res, next) => {
        const fmt = req?.query?.format ? String(req.query.format) : undefined;
        const { authorization } = req.headers;
        const authHeader = authorization?.startsWith("Bearer ") ? authorization.substring(7) : authorization;

        res.setHeader("API-Info", `geniURL v${packageJson.version} (${packageJson.homepage})`);

        if(authHeader && authTokens.has(authHeader))
            return next();

        const setRateLimitHeaders = (rateLimiterRes: RateLimiterRes) => {
            res.setHeader("Retry-After", rateLimiterRes.msBeforeNext / 1000);
            res.setHeader("X-RateLimit-Limit", rateLimiter.points);
            res.setHeader("X-RateLimit-Remaining", rateLimiterRes.remainingPoints);
            res.setHeader("X-RateLimit-Reset", new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());
        };

        rateLimiter.consume(req.ip)
            .then((rateLimiterRes: RateLimiterRes) => {
                setRateLimitHeaders(rateLimiterRes);
                return next();
            })
            .catch((err) => {
                if(err instanceof RateLimiterRes) {
                    setRateLimitHeaders(err);
                    return respond(res, 429, { message: "You are being rate limited. Please try again a little later." }, fmt);
                }
                else return respond(res, 500, { message: "Encountered an internal error. Please try again a little later." }, fmt);
            });
    });

    const listener = app.listen(port, host, () => {
        registerRoutes();

        console.log(k.green(`Listening on ${host}:${port}`));
    });

    listener.on("error", (err) => error("General server error", err, true));
}

function registerRoutes()
{
    try
    {
        initRouter(app);
    }
    catch(err)
    {
        error("Error while initializing router", err instanceof Error ? err : undefined, true);
    }
}

function getAuthTokens() {
    const envVal = process.env["AUTH_TOKENS"];
    let tokens: string[] = [];

    if(!envVal || envVal.length === 0)
        tokens = [];
    else
        tokens = envVal.split(/,/g);

    return new Set<string>(tokens);
}
