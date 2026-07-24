import Stripe from "stripe";

let cached: Stripe | null = null;

/**
 * Lazily-constructed Stripe client. Throws at call time (not import time) if
 * STRIPE_SECRET_KEY isn't configured, so routes that don't touch Stripe never
 * fail to load just because the key is missing in a given environment.
 */
export function getStripe(): Stripe {
  if (cached) return cached;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  cached = new Stripe(secretKey);
  return cached;
}
