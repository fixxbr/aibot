import { forbidden, unauthorized } from './errors.js';

// Authentication is delegated to the platform adapter (FixBridge owns identity).
export function authenticate(platform) {
  return async (req, res, next) => {
    try {
      const user = await platform.authenticate(req);
      if (!user) return next(unauthorized());
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  next();
};
