var http = require("http"),
  https = require("https"),
  common = require("../common"),
  Sender = require("ws/lib/sender"),
  Receiver = require("ws/lib/receiver"),
  PerMessageDeflate = require("ws/lib/permessage-deflate"),
  Extensions = require("ws/lib/extension");

/*!
 * Array of passes.
 *
 * A `pass` is just a function that is executed on `req, socket, options`
 * so that you can easily add new checks while still keeping the base
 * flexible.
 */

/*
 * Websockets Passes
 *
 */

module.exports = {
  /**
   * WebSocket requests must have the `GET` method and
   * the `upgrade:websocket` header
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   *
   * @api private
   */

  checkMethodAndHeader: function checkMethodAndHeader(req, socket) {
    if (req.method !== "GET" || !req.headers.upgrade) {
      socket.destroy();
      return true;
    }

    if (req.headers.upgrade.toLowerCase() !== "websocket") {
      socket.destroy();
      return true;
    }
  },

  /**
   * Sets `x-forwarded-*` headers if specified in config.
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  XHeaders: function XHeaders(req, socket, options) {
    if (!options.xfwd) return;

    var values = {
      for: req.connection.remoteAddress || req.socket.remoteAddress,
      port: common.getPort(req),
      proto: common.hasEncryptedConnection(req) ? "wss" : "ws",
    };

    ["for", "port", "proto"].forEach(function (header) {
      req.headers["x-forwarded-" + header] =
        (req.headers["x-forwarded-" + header] || "") +
        (req.headers["x-forwarded-" + header] ? "," : "") +
        values[header];
    });
  },

  /**
   * Does the actual proxying. Make the request and upgrade it
   * send the Switching Protocols request and pipe the sockets.
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */
  stream: function stream(req, socket, options, head, server, clb) {
    var createHttpHeader = function (line, headers) {
      return (
        Object.keys(headers)
          .reduce(
            function (head, key) {
              var value = headers[key];

              if (!Array.isArray(value)) {
                head.push(key + ": " + value);
                return head;
              }

              for (var i = 0; i < value.length; i++) {
                head.push(key + ": " + value[i]);
              }
              return head;
            },
            [line]
          )
          .join("\r\n") + "\r\n\r\n"
      );
    };

    common.setupSocket(socket);

    if (head && head.length) socket.unshift(head);

    var proxyReq = (common.isSSL.test(options.target.protocol)
      ? https
      : http
    ).request(common.setupOutgoing(options.ssl || {}, options, req));

    // Enable developers to modify the proxyReq before headers are sent
    if (server) {
      server.emit("proxyReqWs", proxyReq, req, socket, options, head);
    }

    // Error Handler
    proxyReq.on("error", onOutgoingError);
    proxyReq.on("response", function (res) {
      // if upgrade event isn't going to happen, close the socket
      if (!res.upgrade) {
        socket.write(
          createHttpHeader(
            "HTTP/" +
              res.httpVersion +
              " " +
              res.statusCode +
              " " +
              res.statusMessage,
            res.headers
          )
        );
        res.pipe(socket);
      }
    });

    proxyReq.on("upgrade", function (proxyRes, proxySocket, proxyHead) {
      proxySocket.on("error", onOutgoingError);

      // Allow us to listen when the websocket has completed
      proxySocket.on("end", function () {
        server.emit("close", proxyRes, proxySocket, proxyHead);
      });

      function handleWebSocketMessage(toClient) {
        function acceptExtensions(offer, isServer) {
          const extensions = {};
          if (offer[PerMessageDeflate.extensionName]) {
            const perMessageDeflate = new PerMessageDeflate({}, isServer);
            perMessageDeflate.accept(offer[PerMessageDeflate.extensionName]);
            extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
          }
          return extensions;
        }

        const extHeader = proxyRes.headers["sec-websocket-extensions"];
        const extensionObj = extHeader && Extensions.parse(extHeader);
        const isCompressed = !!extensionObj[PerMessageDeflate.extensionName];
        const extensionForClient = isCompressed
          ? acceptExtensions(extensionObj, !toClient)
          : null;
        const extensionForServer = isCompressed
          ? acceptExtensions(extensionObj, toClient)
          : null;
        const receiver = new Receiver(null, extensionForClient);
        const sender = new Sender(
          toClient ? socket : proxySocket,
          extensionForServer
        );

        (toClient ? socket : proxySocket).on("data", function (data) {
          receiver.write(data);
        });

        receiver.on("error", onOutgoingError);
        receiver.on("ping", (data) => sender.ping(data, false));
        receiver.on("pong", (data) => sender.pong(data, false));
        receiver.on("conclude", (code, reason) => {
          if (code === 1005) sender.close(undefined);
          else sender.close(code, reason, false);
        });
        receiver.on("message", (data) => {
          console.log("message", data);
          data = toClient
            ? options.serverTransform(data)
            : options.clientTransform(data);
          sender.send(data, {
            fin: true,
            mask: false,
            compress: isCompressed,
            binary: typeof data !== "string",
          });
        });
      }

      // The pipe below will end proxySocket if socket closes cleanly, but not
      // if it errors (eg, vanishes from the net and starts returning
      // EHOSTUNREACH). We need to do that explicitly.
      socket.on("error", function () {
        proxySocket.end();
      });

      common.setupSocket(proxySocket);

      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);

      //
      // Remark: Handle writing the headers to the socket when switching protocols
      // Also handles when a header is an array
      //
      socket.write(
        createHttpHeader("HTTP/1.1 101 Switching Protocols", proxyRes.headers)
      );

      if (options.clientTransform) {
        handleWebSocketMessage(true);
        socket.pipe(proxySocket);
      }
      if (options.serverTransform) {
        handleWebSocketMessage(false);
        proxySocket.pipe(socket);
      }
      server.emit("open", proxySocket, req);
      server.emit("proxySocket", proxySocket); //DEPRECATED.
    });

    return proxyReq.end(); // XXX: CHECK IF THIS IS THIS CORRECT

    function onOutgoingError(err) {
      if (clb) {
        clb(err, req, socket);
      } else {
        server.emit("error", err, req, socket);
      }
      socket.end();
    }
  },
};
