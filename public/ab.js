// AB Testing Client Script
(function() {
  // Hide page immediately
  document.documentElement.classList.add('ab-hide');
  
  // Add styles
  var style = document.createElement('style');
  style.textContent = 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
  document.head.appendChild(style);

  // Load the resolver script
  var script = document.createElement('script');
  script.src = 'https://ab-resolver.onrender.com/exp/resolve.js?url=' + encodeURIComponent(location.href);
  script.onload = function() {
    // Script loaded, check for redirect
    var cookies = document.cookie.split(';');
    var expCookie = cookies.find(function(c) { 
      return c.trim().startsWith('expvar_');
    });

    if (expCookie && expCookie.trim().endsWith('=B')) {
      // We're variant B, check if redirect needed
      fetch('https://ab-resolver.onrender.com/exp/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        console.error('[AB Test] Error:', err);
        document.documentElement.classList.remove('ab-hide');
      });
    } else {
      // Not variant B, just unhide
      document.documentElement.classList.remove('ab-hide');
    }
  };
  script.onerror = function(err) {
    console.error('[AB Test] Failed to load resolver script:', err);
    document.documentElement.classList.remove('ab-hide');
  };
  document.head.appendChild(script);
})();
