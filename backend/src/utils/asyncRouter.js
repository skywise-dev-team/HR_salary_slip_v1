const express = require('express');

// Express 4 does not catch rejected promises thrown inside async route
// handlers or middleware — an unhandled rejection like that can crash the
// whole Node process (visible as "app crashed" in nodemon). This factory
// wraps every async handler/middleware passed to a router method so that
// thrown errors are forwarded to next(err) and handled by the central
// error handler in server.js instead of taking the process down.
function asyncRouter() {
  const router = express.Router();
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'use'];

  methods.forEach((method) => {
    const original = router[method].bind(router);
    router[method] = (...args) => {
      const wrapped = args.map((arg) => {
        if (typeof arg !== 'function') return arg;
        if (arg.constructor.name !== 'AsyncFunction') return arg;
        return (req, res, next) => Promise.resolve(arg(req, res, next)).catch(next);
      });
      return original(...wrapped);
    };
  });

  return router;
}

module.exports = asyncRouter;
