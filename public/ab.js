// AB Testing Client Script
(function() {
  // Hide page immediately
  document.documentElement.classList.add('ab-hide');
  
  // Add styles
  var style = document.createElement('style');
  style.textContent = 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
  document.head.appendChild(style);

  // Get existing variant from cookie
  function getExperimentCookie() {
    var cookies = document.cookie.split(';');
    var expCookie = cookies.find(function(c) { 
      return c.trim().startsWith('expvar_');
    });
    if (expCookie) {
      var parts = expCookie.split('=');
      return {
        id: parts[0].trim().replace('expvar_', ''),
        variant: parts[1].trim()
      };
    }
    return null;
  }

  // Check experiment and handle redirect
  function checkExperiment() {
    fetch('https://ab-resolver.onrender.com/exp/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        url: location.href,
        // Pass existing variant if we have one
        variant: (getExperimentCookie() || {}).variant
      })
    })
    .then(function(response) { return response.json(); })
    .then(function(exp) {
      console.log('[AB Test] Got response:', exp);
      
      if (exp.active) {
        // Set cookie if needed
        var cookieName = 'expvar_' + exp.id;
        var cookieValue = exp.variant;
        document.cookie = cookieName + '=' + cookieValue + '; Path=/; Expires=' + new Date(Date.now() + 90*24*60*60*1000).toUTCString() + '; SameSite=Lax';
        
        // Check if redirect needed
        if (exp.variant === 'B') {
          var current = location.pathname.replace(/\/$/, '');
          var baseline = new URL(exp.baseline_url).pathname.replace(/\/$/, '');
          
          if (current === baseline) {
            console.log('[AB Test] Redirecting to test variant');
            var test = new URL(exp.test_url);
            test.search = location.search || '';
            test.hash = location.hash || '';
            location.replace(test.toString());
            return;
          }
        }
        
        // Push to dataLayer
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
          event: 'exp_exposure',
          experiment_id: exp.id,
          variant_id: exp.variant
        });
      }
      
      // No redirect needed
      console.log('[AB Test] No redirect needed');
      document.documentElement.classList.remove('ab-hide');
    })
    .catch(function(err) {
      console.error('[AB Test] Error:', err);
      document.documentElement.classList.remove('ab-hide');
    });
  }

  // Start experiment check
  checkExperiment();
})();