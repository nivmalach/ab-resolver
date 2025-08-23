// AB Testing Client Script
(function() {
  // Hide page immediately
  document.documentElement.classList.add('ab-hide');
  
  // Add styles
  var style = document.createElement('style');
  style.textContent = 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
  document.head.appendChild(style);

  function init() {
    try {
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
          xhr.send(JSON.stringify({ url: location.href }));
          
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
                return; // Don't unhide if redirecting
              }
            }
          }
        }
      }

      // Load resolver script
      var script = document.createElement('script');
      script.src = 'https://ab-resolver.onrender.com/exp/resolve.js?url=' + encodeURIComponent(location.href);
      script.onload = function() {
        // Check if experiment data was pushed to dataLayer
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
        console.debug('[AB Test] Failed to load resolver script:', err);
        document.documentElement.classList.remove('ab-hide');
      };
      document.head.appendChild(script);
    } catch(e) {
      console.error('[AB Test] Error:', e);
      document.documentElement.classList.remove('ab-hide');
    }
  }

  // Initialize as soon as possible
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
