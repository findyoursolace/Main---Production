/**
 * minicart-promo.js
 * - Keeps promo bar in sync with cart count
 * - Adds/maintains VARIANT upsell behavior (no "control" upsells)
 * - Rebind-safe: works across Horizon morphs / section rerenders
 *
 * Key design principles:
 * - This script ONLY owns the promo bar and upsell visibility.
 *   It does NOT attempt to re-render Horizon's cart drawer or line items.
 *   Horizon owns its own DOM — we hook into its events, we don't replace its HTML.
 * - For upsell adds, we use Horizon's native cart add path (if available) so
 *   Horizon handles its own line item refresh, bubble count, etc.
 * - fetchInFlight deduplication prevents concurrent /cart.js races.
 * - Self-event guard prevents feedback loops from our own cart:update dispatches.
 * - A MutationObserver re-runs promo updates after any Horizon section morph so
 *   the bar is never wiped by a DOM swap (page load, drawer open, etc).
 */
(function () {
  if (window.__miniCartPromoInit) return;
  window.__miniCartPromoInit = true;

  var promoRefreshTimer = null;
  var fetchInFlight = null;
  var morphObserver = null;

  /* -----------------------------
   * Promo helpers
   * ----------------------------- */
  function getCartCount(cart, el) {
    if (!cart) return 0;

    var idsAttr = el && el.getAttribute('data-promo-product-ids');
    if (!idsAttr) {
      return typeof cart.item_count === 'number'
        ? cart.item_count
        : typeof cart.itemCount === 'number'
          ? cart.itemCount
          : 0;
    }

    if (!cart.items || !cart.items.length) return 0;

    var allowedIds = idsAttr
      .split(',')
      .map(function (id) { return parseInt(id, 10); })
      .filter(function (id) { return !isNaN(id); });

    if (!allowedIds.length) return 0;

    var total = 0;
    for (var i = 0; i < cart.items.length; i++) {
      var item = cart.items[i];
      if (allowedIds.indexOf(item.product_id) !== -1) {
        total += item.quantity || 0;
      }
    }
    return total;
  }

  function formatMessage(template, remaining) {
    return (template || '').replace('[remaining]', String(remaining));
  }

  function computeState(qty, tier1, tier2) {
    if (qty < tier1) return 'before_first';
    if (qty >= tier1 && qty < tier2) return 'after_first';
    return 'after_second';
  }

  function updatePromoElement(el, cartLike) {
    if (!el) return;

    var tier1 = parseInt(el.getAttribute('data-tier1-qty'), 10) || 0;
    var tier2 = parseInt(el.getAttribute('data-tier2-qty'), 10) || 0;
    if (!tier1 || !tier2) return;

    var msgBeforeFirst  = el.getAttribute('data-msg-before-first')  || '';
    var msgAfterFirst   = el.getAttribute('data-msg-after-first')   || '';
    var msgAfterSecond  = el.getAttribute('data-msg-after-second')  || '';
    var msgExactTier1   = el.getAttribute('data-msg-exact-tier1')   || '';

    var msgEl     = el.querySelector('[data-minicart-promo-message]');
    var fillEl    = el.querySelector('[data-minicart-promo-fill]');
    var marker1El = el.querySelector('[data-minicart-promo-marker1]');
    var marker2El = el.querySelector('[data-minicart-promo-marker2]');

    var qty = getCartCount(cartLike, el);
    var state = computeState(qty, tier1, tier2);
    var remainingToTier1 = Math.max(tier1 - qty, 0);
    var remainingToTier2 = Math.max(tier2 - qty, 0);

    var message = '';
    if (state === 'before_first') {
      message = formatMessage(msgBeforeFirst, remainingToTier1);
    } else if (state === 'after_first') {
      message = (qty === tier1 && msgExactTier1)
        ? msgExactTier1
        : formatMessage(msgAfterFirst, remainingToTier2);
    } else {
      message = msgAfterSecond || '';
    }

    if (msgEl) msgEl.textContent = message;

    var progress = Math.min(qty / tier2, 1) * 100;
    if (fillEl) fillEl.style.width = progress + '%';

    var tier1Percent = (tier1 / tier2) * 100;
    if (marker1El) {
      marker1El.style.left = tier1Percent + '%';
      marker1El.classList.toggle('is-active', qty >= tier1);
    }
    if (marker2El) {
      marker2El.style.left = '100%';
      marker2El.classList.toggle('is-active', qty >= tier2);
    }
  }

  function updateAllPromos(cartLike) {
    var els = document.querySelectorAll('[data-minicart-promo]');
    if (!els || !els.length) return;
    els.forEach(function (el) { updatePromoElement(el, cartLike); });
  }

  function refreshPromosAfterPaint() {
    if (promoRefreshTimer) clearTimeout(promoRefreshTimer);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        promoRefreshTimer = setTimeout(fetchCartAndUpdate, 120);
      });
    });
  }

  /* -----------------------------
   * MutationObserver — re-apply promo state after any Horizon DOM morph
   *
   * Horizon's section rendering (page load hydration, drawer open, cart updates)
   * replaces innerHTML in the cart drawer, which wipes any inline styles we set
   * on promo fill elements. The observer detects those DOM swaps and re-runs
   * our promo update using the last known good cart data.
   * ----------------------------- */
  var lastKnownCart = null;

  function startMorphObserver() {
    if (morphObserver) return;

    // Watch the whole document subtree for large DOM changes that indicate a
    // section re-render (Horizon swaps entire subtrees, not individual nodes)
    morphObserver = new MutationObserver(function (mutations) {
      var significant = false;
      for (var i = 0; i < mutations.length; i++) {
        // Any added nodes that are elements (not text) = potential section swap
        if (mutations[i].addedNodes && mutations[i].addedNodes.length) {
          for (var j = 0; j < mutations[i].addedNodes.length; j++) {
            if (mutations[i].addedNodes[j].nodeType === 1) {
              significant = true;
              break;
            }
          }
        }
        if (significant) break;
      }

      if (!significant) return;

      // Re-apply last known cart state immediately (no fetch needed —
      // we already have the correct data, Horizon just wiped our styles)
      if (lastKnownCart) {
        updateAllPromos(lastKnownCart);
        updateVariantUpsells(lastKnownCart);
      }

      // Then schedule a fresh fetch in case the morph included new cart data
      refreshPromosAfterPaint();
    });

    morphObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /* -----------------------------
   * Variant upsell helpers (Horizon)
   * ----------------------------- */
  function getCartBandwidthFromCart(cart) {
    var valid = ['38/40/41/42MM', '44/45/46/49MM'];
    if (!cart || !cart.items || !cart.items.length) return null;

    for (var i = 0; i < cart.items.length; i++) {
      var item = cart.items[i];
      var opts = item && item.options_with_values ? item.options_with_values : null;
      if (!opts || !opts.length) continue;
      for (var j = 0; j < opts.length; j++) {
        var o = opts[j];
        if (o && o.name === 'Bandwidth') {
          var v = (o.value || '').trim();
          if (valid.indexOf(v) !== -1) return v;
        }
      }
    }
    return null;
  }

  function getCartVariantIdsFromCart(cart) {
    var out = [];
    if (!cart || !cart.items) return out;
    for (var i = 0; i < cart.items.length; i++) {
      var id = cart.items[i] && cart.items[i].variant_id;
      if (typeof id === 'number') out.push(id);
    }
    return out;
  }

  function toggleElActive(el, on) {
    if (!el) return;
    el.classList.toggle('active', !!on);
  }

  function updateVariantUpsells(cart) {
    var wrapper = document.querySelector('#miniCartUpsellVariant');
    if (!wrapper) return;

    var title = document.querySelector('#miniCartUpsellVariantTitle');
    var cartBandwidth  = getCartBandwidthFromCart(cart);
    var cartVariantIds = getCartVariantIdsFromCart(cart);

    var upsells = document.querySelectorAll('.miniCartUpsellItem--variant');
    if (!upsells || !upsells.length) {
      toggleElActive(wrapper, false);
      toggleElActive(title, false);
      return;
    }

    var anyActive = false;

    upsells.forEach(function (el) {
      var variantId = parseInt(
        el.getAttribute('data-variant') || el.getAttribute('data-variant-id') || '', 10
      );
      var ignoreBandwidth = (el.getAttribute('data-ignore-bandwidth') || '').toLowerCase() === 'true';
      var requiredBw      = (el.getAttribute('data-required-bandwidth') || '').trim();
      var requiredBwDown  = requiredBw.toLowerCase();
      var isUniversal     = requiredBwDown.indexOf('universal') !== -1;

      var shouldShow = true;

      if (variantId && cartVariantIds.indexOf(variantId) !== -1) shouldShow = false;

      if (shouldShow && !ignoreBandwidth && !isUniversal && requiredBw) {
        if (!cartBandwidth) {
          shouldShow = false;
        } else if (String(cartBandwidth).toLowerCase().trim() !== requiredBwDown) {
          shouldShow = false;
        }
      }

      toggleElActive(el, shouldShow);
      if (shouldShow) anyActive = true;
    });

    toggleElActive(wrapper, anyActive);
    toggleElActive(title, anyActive);
  }

  /* -----------------------------
   * Cart fetch
   * ----------------------------- */
  function fetchCartAndUpdate() {
    if (fetchInFlight) return fetchInFlight;

    fetchInFlight = fetch('/cart.js')
      .then(function (res) { return res.json(); })
      .then(function (cart) {
        lastKnownCart = cart;
        updateAllPromos(cart);
        updateVariantUpsells(cart);
        return cart;
      })
      .catch(function () {})
      .finally(function () { fetchInFlight = null; });

    return fetchInFlight;
  }

  /* -----------------------------
   * Upsell add to cart
   *
   * Strategy: use Horizon's own add-to-cart machinery when available so that
   * Horizon handles the line item render and cart bubble update itself.
   * We only handle the promo bar update on top of that.
   * ----------------------------- */
  function dispatchCartUpdateWithCount(itemCount) {
    try {
      document.dispatchEvent(new CustomEvent('cart:update', {
        bubbles: true,
        detail: {
          data: {
            itemCount: typeof itemCount === 'number' ? itemCount : null,
            source: 'minicart-upsell',
          },
        },
      }));
    } catch (e) {}
  }

  function addViaHorizonComponent(variantId) {
    // Horizon exposes a global `window.theme.cart.add()` in some versions
    if (window.theme && window.theme.cart && typeof window.theme.cart.add === 'function') {
      return window.theme.cart.add({ id: variantId, quantity: 1 })
        .then(function () { return true; })
        .catch(function () { return false; });
    }

    // Some Horizon builds expose a CartAPI helper
    if (window.CartAPI && typeof window.CartAPI.addItem === 'function') {
      return window.CartAPI.addItem({ id: variantId, quantity: 1 })
        .then(function () { return true; })
        .catch(function () { return false; });
    }

    // Horizon cart-drawer custom element sometimes has an `addToCart` method
    var drawerEl = document.querySelector('cart-drawer');
    if (drawerEl && typeof drawerEl.addToCart === 'function') {
      return drawerEl.addToCart({ id: variantId, quantity: 1 })
        .then(function () { return true; })
        .catch(function () { return false; });
    }

    return Promise.resolve(false);
  }

  function addUpsellVariantToCart(variantId, buttonEl) {
    if (!variantId) return;

    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.classList.add('loading');
    }

    // Try Horizon's own add path first. If it succeeds, Horizon handles the
    // line item list and bubble update — we just update the promo bar on top.
    addViaHorizonComponent(variantId)
      .then(function (handledByHorizon) {
        if (handledByHorizon) {
          // Horizon did the cart mutation — just fetch fresh cart for our promo bar
          fetchInFlight = null;
          return fetchCartAndUpdate().then(function (cart) {
            dispatchCartUpdateWithCount(cart && typeof cart.item_count === 'number' ? cart.item_count : null);
            refreshPromosAfterPaint();
          });
        }

        // Horizon component not available — do a raw fetch add and then fire the
        // standard Horizon cart:refresh event so it re-renders its own components.
        return fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
        })
          .then(function () {
            fetchInFlight = null;
            return fetchCartAndUpdate();
          })
          .then(function (cart) {
            dispatchCartUpdateWithCount(
              cart && typeof cart.item_count === 'number' ? cart.item_count : null
            );

            // Fire cart:refresh so Horizon re-renders line items and bubble.
            // We do NOT touch the DOM ourselves — Horizon owns that.
            try { document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true })); } catch (e) {}
            try { window.dispatchEvent(new CustomEvent('cart', { bubbles: true })); } catch (e) {}

            refreshPromosAfterPaint();
          });
      })
      .catch(function () {})
      .finally(function () {
        if (buttonEl) {
          buttonEl.disabled = false;
          buttonEl.classList.remove('loading');
        }
      });
  }

  function bindUpsellClicksOnce() {
    if (document.querySelector('cart-drawer-component')) return;
    if (document.documentElement.hasAttribute('data-upsell-delegate-bound')) return;
    document.documentElement.setAttribute('data-upsell-delegate-bound', 'true');

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest
        ? e.target.closest('.miniCartUpsellItemBtn')
        : null;
      if (!btn) return;

      var variantId = parseInt(
        btn.getAttribute('data-variant-id') || btn.getAttribute('data-variant') || '', 10
      );
      if (!variantId) return;

      e.preventDefault();
      addUpsellVariantToCart(variantId, btn);
    });
  }

  /* -----------------------------
   * Init
   * ----------------------------- */
  function init() {
    startMorphObserver();
    fetchCartAndUpdate();
    bindUpsellClicksOnce();

    document.addEventListener('cart:update', function (event) {
      var detail = event && event.detail ? event.detail : null;
      var data   = detail && detail.data ? detail.data : null;

      // Self-event guard: ignore events we dispatched to avoid a feedback loop
      if (data && data.source === 'minicart-upsell') return;

      if (data && data.items) {
        updateAllPromos(data);
        updateVariantUpsells(data);
      }

      refreshPromosAfterPaint();
    });

    window.updateMiniCartPromo = function (cartLike) {
      if (cartLike) {
        updateAllPromos(cartLike);
        if (cartLike.items) updateVariantUpsells(cartLike);
        refreshPromosAfterPaint();
      } else {
        refreshPromosAfterPaint();
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();