// AB Testing Client Script
(function() {
  try {
    // Hide page immediately
    document.documentElement.classList.add('ab-hide');
    
    // Add styles
    var style = document.createElement('style');
    style.textContent = 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
    document.head.appendChild(style);

    // Check for existing variant
    var cookies = document.cookie.split(';');
    var expCookie = cookies.find(function(c) { 
      return c.trim().startsWith('expvar_');
    });
    
    if (expCookie) {
      var parts = expCookie.split('=');
      var expId = parts[0].trim().replace('expvar_', '');
      var variant = parts[1].trim();
      
      // If variant B, check if we need to redirect
      if (variant === 'B') {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://ab-resolver.onrender.com/exp/resolve', false); // Synchronous!
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true; // Enable CORS with credentials
        xhr.send(JSON.stringify({ 
          url: location.href,
          cid: expId // Pass experiment ID as client ID
        }));
        
        if (xhr.status === 200) {
          var exp = JSON.parse(xhr.responseText);
          if (exp.active && exp.id === expId) {
            var current = location.pathname.replace(/\/$/, '');
            var baseline = new URL(exp.baseline_url).pathname.replace(/\/$/, '');
            
            if (current === baseline) {
              var test = new URL(exp.test_url);
              test.search = location.search || '';
              test.hash = location.hash || '';
              location.replace(test.toString());
              return; // Don't continue if redirecting
            }
          }
        }
      }
    }

    // No redirect needed, load resolver script
    var script = document.createElement('script');
    script.src = 'https://ab-resolver.onrender.com/exp/resolve.js?url=' + encodeURIComponent(location.href);
    script.onload = function() {
      // Unhide the page
      document.documentElement.classList.remove('ab-hide');
      
      // Check dataLayer
      if (window.dataLayer) {
        var hasExpEvent = window.dataLayer.some(function(entry) {
          return entry && entry.event === 'exp_exposure';
        });
        if (!hasExpEvent) {
          console.debug('[AB Test] No exp_exposure event found in dataLayer');
        }
      }
    };
    script.onerror = function(err) {
      console.error('[AB Test] Failed to load resolver script:', err);
      document.documentElement.classList.remove('ab-hide');
    };
    document.head.appendChild(script);
  } catch(e) {
    console.error('[AB Test] Error:', e);
    document.documentElement.classList.remove('ab-hide');
  }
})();