// AB Testing Helper Script
(function() {
  var DEBUG = true; // Set to false in production
  var RESOLVER_DOMAIN = document.currentScript.src.split('/admin/')[0];
  
  function log(...args) {
    if (DEBUG) console.log('[AB Test]', ...args);
  }

  // Initialize AB testing
  function initABTest() {
    log('Initializing...');
    
    // Add styles
    var style = document.createElement('style');
    style.textContent = 'html.ab-hide{opacity:0!important;transition:opacity .1s}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
    document.head.appendChild(style);
    log('Styles added');
    
    // Add hide class immediately
    document.documentElement.classList.add('ab-hide');
    log('Hide class added');
    
    // Get the current URL
    var currentUrl = window.location.href;
    log('Current URL:', currentUrl);
    
    // Create and inject the resolver script
    var script = document.createElement('script');
    script.src = RESOLVER_DOMAIN + '/exp/resolve.js?url=' + encodeURIComponent(currentUrl);
    log('Resolver URL:', script.src);
    
    // Add debug event listener
    script.addEventListener('load', function() {
      log('Resolver script loaded');
      
      // Check if experiment data was pushed to dataLayer
      if (window.dataLayer) {
        var hasExpEvent = window.dataLayer.some(function(entry) {
          return entry && entry.event === 'exp_exposure';
        });
        log('DataLayer status:', hasExpEvent ? 'exp_exposure found' : 'no exp_exposure event');
        
        // Check cookies
        var cookies = document.cookie.split(';').map(c => c.trim());
        var expCookie = cookies.find(c => c.startsWith('expvar_'));
        log('Experiment cookie:', expCookie || 'not found');
      }
    });
    
    // Add error handling
    script.addEventListener('error', function(err) {
      log('Error loading resolver script:', err);
      // Remove hide class in case of error
      document.documentElement.classList.remove('ab-hide');
    });
    
    // Inject the script
    document.head.appendChild(script);
    log('Resolver script injected');
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initABTest);
    log('Waiting for DOMContentLoaded');
  } else {
    initABTest();
  }
})();
