(function initPageState() {
  const key = 'gavel_page_state:' + window.location.pathname;

  function load() {
    try {
      return JSON.parse(sessionStorage.getItem(key) || '{}');
    } catch (e) {
      return {};
    }
  }

  function save(next) {
    try {
      sessionStorage.setItem(key, JSON.stringify(Object.assign(load(), next)));
    } catch (e) {}
  }

  window.GavelPageState = {
    load: load,
    save: save,
    clear: function() {
      try { sessionStorage.removeItem(key); } catch (e) {}
    }
  };

  window.addEventListener('beforeunload', function() {
    save({ scrollY: window.scrollY });
  });

  window.addEventListener('pageshow', function() {
    const state = load();
    if (typeof state.scrollY === 'number') {
      window.requestAnimationFrame(function() {
        window.scrollTo(0, state.scrollY);
      });
    }
  });
})();
