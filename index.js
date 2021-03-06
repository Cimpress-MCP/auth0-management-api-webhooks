const async   = require('async');
const express = require('express');
const Webtask = require('webtask-tools');
const app     = express();
const Request  = require('request');
const memoizer = require('lru-memoizer');

function lastLogCheckpoint(req, res) {
  let ctx               = req.webtaskContext;
  let required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'WEBHOOK_URL'];
  let missing_settings  = required_settings.filter((setting) => !ctx.data[setting]);

  if (missing_settings.length) {
    return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
  }

  // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
  req.webtaskContext.storage.get((err, data) => {
    if (err && err.output.statusCode !== 404) return res.status(err.code).send(err);

    let startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;

    // Start the process.
    async.waterfall([
      (callback) => {
        const getLogs = (context) => {
          console.log(`Logs from: ${context.checkpointId || 'Start'}.`);

          let take = Number.parseInt(ctx.data.BATCH_SIZE);

          take = take > 100 ? 100 : take;

          context.logs = context.logs || [];

          getLogsFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.access_token, take, context.checkpointId, (logs, err) => {
            if (err) {
              console.log('Error getting logs from Auth0', err);
              return callback(err);
            }

            if (logs && logs.length) {
              logs.forEach((l) => context.logs.push(l));
              context.checkpointId = context.logs[context.logs.length - 1]._id;
            }

            console.log(`Total logs: ${context.logs.length}.`);
            return callback(null, context);
          });
        };

        getLogs({ checkpointId: startCheckpointId });
      },
      (context, callback) => {
        let endpoints_filter = ctx.data.AUTH0_API_ENDPOINTS.split(',');
        endpoints_filter = endpoints_filter.length > 0 && endpoints_filter[0] === '' ? [] : endpoints_filter;
        const request_matches_filter = (log) => {
          if (!endpoints_filter || !endpoints_filter.length) return true;
          return log.details.request && log.details.request.path &&
            endpoints_filter.some(f =>
              log.details.request.path === `/api/v2/${f}`
                || log.details.request.path.indexOf(`/api/v2/${f}/`) >= 0);
        };

        context.logs = context.logs
          .filter(l => l.type === 'sapi' || l.type === 'fapi')
          .filter(request_matches_filter)
          .map(l => {
            return {
              date: l.date,
              request: l.details.request,
              response: l.details.response
            };
          });

        callback(null, context);
      },
      // Get authentication token if requested
      (context, callback) => {
        if (ctx.data.WEBHOOK_AUTH_CLIENT_ID && ctx.data.WEBHOOK_AUTH_CLIENT_SECRET && ctx.data.WEBHOOK_AUTH_RESOURCE_SERVER) {
          getTokenCached(`https://${ctx.data.AUTH0_DOMAIN}/oauth/token`, ctx.data.WEBHOOK_AUTH_RESOURCE_SERVER, ctx.data.WEBHOOK_AUTH_CLIENT_ID, ctx.data.WEBHOOK_AUTH_CLIENT_SECRET, (access_token, err) => {
            if (err) return callback(err)
            else {
              context.headers = { authorization: `Bearer ${access_token}` }
              return callback(null, context)
            }
          })
        } else return callback(null, context)
      },
      //// STEP 4: Sending information
      (context, callback) => {
        if (!context.logs.length) {
          return callback(null, context);
        }

        const url              = ctx.data.WEBHOOK_URL;
        const concurrent_calls = ctx.data.WEBHOOK_CONCURRENT_CALLS || 5;

        console.log(`Sending to '${url}' with ${concurrent_calls} concurrent calls.`);

        async.eachLimit(context.logs, concurrent_calls, (log, cb) => {
          Request({
            method: 'POST',
            url: url,
            json: true,
            body: log,
            headers: context.headers
          }, (err, res, body) => {
            if (err) {
              console.log('Error sending request:', err);
              return cb(err);
            }

            if (res.statusCode.toString().indexOf('2') !== 0) {
              console.log('Unexpected response while sending request:', JSON.stringify(res.body));
              return cb(new Error('Unexpected response from webhook.'));
            }

            cb();
          });
        }, (err) => {
          if (err) {
            return callback(err);
          }

          console.log('Upload complete.');
          return callback(null, context);
        });
      }
    ], (err, context) => {
      if (err) {
        console.log('Job failed.');

        return req.webtaskContext.storage.set({checkpointId: startCheckpointId}, {force: 1}, (error) => {
          if (error) {
            console.log('Error storing startCheckpoint', error);
            return res.status(500).send({error: error});
          }

          res.status(500).send({
            error: err
          });
        });
      }

      console.log('Job complete.');

      return req.webtaskContext.storage.set({
        checkpointId: context.checkpointId,
        totalLogsProcessed: context.logs.length
      }, {force: 1}, (error) => {
        if (error) {
          console.log('Error storing checkpoint', error);
          return res.status(500).send({error: error});
        }

        res.sendStatus(200);
      });
    });
  });
}

function getLogsFromAuth0 (domain, token, take, from, cb) {
  var url = `https://${domain}/api/v2/logs`;

  Request({
    method: 'GET',
    url: url,
    json: true,
    qs: {
      take: take,
      from: from,
      sort: 'date:1',
      per_page: take
    },
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  }, (err, res, body) => {
    if (err) {
      console.log('Error getting logs', err);
      cb(null, err);
    } else {
      cb(body);
    }
  });
}

const getTokenCached = memoizer({
  load: (apiUrl, audience, clientId, clientSecret, cb) => {
    Request({
      method: 'POST',
      url: apiUrl,
      json: true,
      body: {
        audience: audience,
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      }
    }, (err, res, body) => {
      if (err) {
        cb(null, err);
      } else {
        cb(body.access_token);
      }
    });
  },
  hash: (apiUrl) => apiUrl,
  max: 100,
  maxAge: 1000 * 60 * 60
});

app.use(function (req, res, next) {
  var apiUrl = `https://${req.webtaskContext.data.AUTH0_DOMAIN}/oauth/token`;
  var audience = `https://${req.webtaskContext.data.AUTH0_DOMAIN}/api/v2/`;
  var clientId = req.webtaskContext.data.AUTH0_CLIENT_ID;
  var clientSecret = req.webtaskContext.data.AUTH0_CLIENT_SECRET;

  getTokenCached(apiUrl, audience, clientId, clientSecret, function (access_token, err) {
    if (err) {
      console.log('Error getting access_token', err);
      return next(err);
    }

    req.access_token = access_token;
    next();
  });
});

app.get ('/', lastLogCheckpoint);
app.post('/', lastLogCheckpoint);

module.exports = Webtask.fromExpress(app);
