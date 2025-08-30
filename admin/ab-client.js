// AB Testing Client Script
(function() {
  // Hide page immediately
  document.documentElement.classList.add('ab-hide');
  
  // Add styles
  var style = document.createElement('style');
  style.textContent = 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
  document.head.appendChild(style);

  // Load the resolver script first
  var script = document.createElement('script');
  script.src = 'https://ab-resolver.onrender.com/exp/resolve.js?url=' + encodeURIComponent(location.href);
  script.onerror = function(err) {
    console.error('[AB Test] Failed to load resolver script:', err);
    document.documentElement.classList.remove('ab-hide');
  };
  document.head.appendChild(script);

  // Check for redirect every 100ms for up to 2 seconds
  var checkCount = 0;
  var checkInterval = setInterval(function() {
    try {
      var cookies = document.cookie.split(';');
      var expCookie = cookies.find(function(c) { 
        return c.trim().startsWith('expvar_');
      });

      if (expCookie) {
        var parts = expCookie.split('=');
        var variant = parts[1].trim();
        
        if (variant === 'B') {
          // Use fetch instead of XHR
          fetch('https://ab-resolver.onrender.com/exp/resolve', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url: location.href })
          })
          .then(function(response) { return response.json(); })
          .then(function(exp) {
            if (exp.active) {
              var current = location.pathname.replace(/\/$/, '');
              var baseline = new URL(exp.baseline_url).pathname.replace(/\/$/, '');
              
              if (current === baseline) {
                var test = new URL(exp.test_url);
                test.search = location.search || '';
                test.hash = location.hash || '';
                location.replace(test.toString());
                return;
              }
            }
            document.documentElement.classList.remove('ab-hide');
          })
          .catch(function(err) {
            console.error('[AB Test] Error checking redirect:', err);
            document.documentElement.classList.remove('ab-hide');
          });
          clearInterval(checkInterval);
        } else {
          document.documentElement.classList.remove('ab-hide');
          clearInterval(checkInterval);
        }
      }
    } catch(e) {
      console.error('[AB Test] Error in redirect check:', e);
    }

    checkCount++;
    if (checkCount >= 20) { // 2 seconds max
      clearInterval(checkInterval);
      document.documentElement.classList.remove('ab-hide');
    }
  }, 100);
})();