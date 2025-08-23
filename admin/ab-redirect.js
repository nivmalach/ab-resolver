// Immediate redirect script - must be placed in <head>
(function() {
  try {
    // Get experiment cookie if exists
    var cookies = document.cookie.split(';');
    var expCookie = cookies.find(function(c) { 
      return c.trim().startsWith('expvar_');
    });
    
    if (expCookie) {
      var parts = expCookie.split('=');
      var expId = parts[0].trim().replace('expvar_', '');
      var variant = parts[1].trim();
      
      // Only proceed if we're variant B
      if (variant === 'B') {
        // Get experiment config
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://ab-resolver.onrender.com/exp/resolve', false); // Synchronous!
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ url: location.href }));
        
        if (xhr.status === 200) {
          var exp = JSON.parse(xhr.responseText);
          if (exp.active && exp.id === expId) {
            // We're on baseline, redirect to test
            var current = location.pathname.replace(/\/$/, '');
            var baseline = new URL(exp.baseline_url).pathname.replace(/\/$/, '');
            
            if (current === baseline) {
              var test = new URL(exp.test_url);
              test.search = location.search || '';
              test.hash = location.hash || '';
              location.replace(test.toString());
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('[AB Test] Early redirect error:', e);
  }
})();
