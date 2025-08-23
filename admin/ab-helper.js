// AB Testing Helper Script
(function() {
  // Initialize AB testing
  function initABTest() {
    // Add hide class immediately
    document.documentElement.classList.add('ab-hide');
    
    // Get the current URL
    var currentUrl = window.location.href;
    
    // Create and inject the resolver script
    var script = document.createElement('script');
    script.src = 'https://ab-resolver.onrender.com/exp/resolve.js?url=' + encodeURIComponent(currentUrl);
    
    // Add debug event listener
    script.addEventListener('load', function() {
      // Check if experiment data was pushed to dataLayer
      if (window.dataLayer) {
        var hasExpEvent = window.dataLayer.some(function(entry) {
          return entry && entry.event === 'exp_exposure';
        });
        if (!hasExpEvent) {
          console.debug('AB Test Debug: No exp_exposure event found in dataLayer');
        }
      }
    });
    
    // Add error handling
    script.addEventListener('error', function(err) {
      console.debug('AB Test Debug: Failed to load resolver script', err);
      // Remove hide class in case of error
      document.documentElement.classList.remove('ab-hide');
    });
    
    // Inject the script
    document.head.appendChild(script);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initABTest);
  } else {
    initABTest();
  }
})();
