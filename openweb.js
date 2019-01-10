// Takes the first chunk of an HTTP response,
// parses the headers and the body to an object.
var parseHeaders = (res) => {
  var s = "\r\n\r\n"
  var ind = res.indexOf(s)
  var headers = res.slice(0,ind)
  var body = res.slice(ind + s.length)
  var obj = {headers: {}}

  headers.split("\r\n").forEach((line) => {
    var ind = line.indexOf(": ")
    var key = line.slice(0, ind)
    var val = line.slice(ind + 2)
    obj.headers[key] = val
  })

  obj.body = body
  obj.mimeType = obj.headers["Content-Type"].slice(0, obj.headers["Content-Type"].indexOf("; "))
  return obj
}

var enc = new TextEncoder()
var dec = new TextDecoder()

// Takes a URL string, opens a TCP connection, sends an HTTP request, receives
// an HTTP response and parses it. The callback function takes the response
// body as a string, and the parsed object from the initial chunk.
var socketMagic = (urlString, cb) => {
  var url = new URL(urlString)
  if (url.protocol !== "http:") {
    return
    // throw new Error("URL should start with http://")
  }
  var httpReqHeader = `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`
  var httpReqHeaderEnc = enc.encode(httpReqHeader)

  chrome.sockets.tcp.create({}, (createInfo) => {
    var socketId = createInfo.socketId
    chrome.sockets.tcp.connect(socketId, url.host, 80, (result) => {
      chrome.sockets.tcp.send(socketId, httpReqHeaderEnc, (sendInfo) => {
        var chunk = 0
        var all = ``
        var len = 0
        var totalLen = 0
        var obj = {}

        chrome.sockets.tcp.onReceive.addListener((recvInfo) => {
          if (recvInfo.socketId != socketId) { return }
          console.log(recvInfo)
          chunk++

          // recvInfo.data is an arrayBuffer.
          var res = dec.decode(recvInfo.data)

          if (chunk === 1) {
            obj = parseHeaders(res)
            all = all.concat(obj.body)
            len += enc.encode(obj.body).byteLength
            totalLen = parseInt(obj.headers["Content-Length"])
          } else {
            all = all.concat(res)
            len += recvInfo.data.byteLength
          }

          console.log(`Chunk ${chunk}, Len: ${len}, TotalLen: ${totalLen}`)

          if(len >= totalLen) {
            console.log(obj)
            cb(all, obj)
            chrome.sockets.tcp.disconnect(socketId)
          }
        })

        chrome.sockets.tcp.onReceiveError.addListener((errInfo) => {
          chrome.sockets.tcp.disconnect(socketId)
        })
      })
    })
  })
}

// Takes an absolute base URL (the page that the browser is looking at),
// the response body as a string, the MIME type,
// and a callback that takes a document.
var domMagic = (baseURL, body, mimeType, cb) => {
  var parser = new DOMParser()
  var doc = parser.parseFromString(body, mimeType)

  // fully qualify all the links. i.e. resolve relative paths etc.
  doc.querySelectorAll("[src], [href]").forEach((elt) => {
    if (elt.attributes.src) {
      var tempURL = new URL(elt.attributes.src.value, baseURL)
      elt.attributes.src.value = tempURL.href
    }
    if (elt.attributes.href) {
      var tempURL = new URL(elt.attributes.href.value, baseURL)
      elt.attributes.href.value = tempURL.href
    }
  })

  // a sourcemap is a dictionary with fully qualified URLs as keys, and the downloaded content as values
  var sourcemap = {}

  // gotta load images and stuff, i.e. socket shit
  var parallelFns = []
  doc.querySelectorAll("img[src], script[src], link[href]").forEach((elt) => {
    var addr = ``
    if (elt.attributes.src) { addr = elt.attributes.src.value }
    if (elt.attributes.href) { addr = elt.attributes.href.value }
    if (sourcemap[addr]) { return } // don't download twice

    parallelFns.push(function (callback) {
      socketMagic(addr, (body, obj) => {
        sourcemap[addr] = `data:${obj.mimeType},${body}`
        callback(null, {})
      })
    })
  })

  runParallel(parallelFns, function (err, results) {
    // now all resources have been downloaded
    console.log(sourcemap);
    cb(doc, sourcemap)
  })
}

// Takes a URL, does all the connection stuff and updates the WebView,
// then calls the callback which takes a document.
var urlMagic = (url, cb) => {
  socketMagic(url, (body, obj) => {
    var webview = document.querySelector("webview")
    webview.src = `data:${obj.mimeType},${body}`
    domMagic(url, body, obj.mimeType, (doc, sourcemap) => {
      // doc is the corrected document
      cb(doc)
    })

    // webview.executeScript({code: `document.documentElement.innerHTML`}, function(results) {
    //   // results[0] would have the webview's innerHTML.
    //   console.log(results)
    // })
  })
}

// Once page loads
document.addEventListener("DOMContentLoaded", (ev) => {
  var go = document.getElementById("go")
  var clear = document.getElementById("clear")
  var webview = document.querySelector("webview")
  webview.src = `data:text/html,` // empty page

  go.addEventListener("click", (ev) => {
    var url = document.getElementById("website").value.trim()
    urlMagic(url, (doc) => {

    })
    // webview.src = url
    // webview.stop()
    // console.log(webview.contentWindow)

  })

  clear.addEventListener("click", (ev) => {
    var clearDataType = {
      appcache: true,
      cache: true, // remove entire cache.
      cookies: true,
    }
    webview.clearData({ since: 0 }, clearDataType, () => {
    // Reload webview after clearing browsing data.
      clear.disabled = true
      clear.attributes.value.value = "Cleared!..."
      setTimeout(() => {
        clear.disabled = false
        clear.attributes.value.value = "Clear cache"
      }, 2000)
    });
  })
})
