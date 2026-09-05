// The pricing section is complete markup; this script fills it in from
// window.yard.project.tiers so the page never carries a tier id or a price
// of its own. Yard injects embed.js, which may land before or after this
// file, so the script waits for it briefly rather than assuming an order.
(function () {
  "use strict";

  var plans = document.getElementById("plans");
  if (!plans) return;

  var tries = 0;

  function ready() {
    return window.yard && window.yard.project && Array.isArray(window.yard.project.tiers);
  }

  function wait() {
    if (ready()) return fill(window.yard.project.tiers);
    if (tries++ < 60) setTimeout(wait, 100);
  }

  function money(cents) {
    var dollars = cents / 100;
    return "$" + (Number.isInteger(dollars) ? dollars : dollars.toFixed(2));
  }

  function setText(root, selector, text) {
    var node = root.querySelector(selector);
    if (node && text) node.textContent = text;
  }

  function setFeatures(root, tier) {
    var list = root.querySelector("[data-features]");
    if (!list || !tier.features || !tier.features.length) return;
    list.textContent = "";
    tier.features.forEach(function (feature) {
      var item = document.createElement("li");
      item.textContent = feature;
      list.appendChild(item);
    });
  }

  function fillFree(card, tier) {
    setText(card, "[data-name]", tier.name);
    setText(card, "[data-amount]", money(tier.price_cents));
    setText(card, "[data-blurb]", tier.description);
    setFeatures(card, tier);
  }

  function fillPro(card, tier) {
    setText(card, "[data-name]", tier.name);
    setText(card, "[data-blurb]", tier.description);
    setFeatures(card, tier);

    var amount = card.querySelector("[data-amount]");
    var per = card.querySelector("[data-per]");
    var billed = card.querySelector("[data-billed]");
    var buy = card.querySelector("[data-buy]");
    var trial = card.querySelector("[data-trial]");
    var toggle = card.querySelector("#interval");

    buy.dataset.tierId = tier.id;
    buy.textContent = "Get " + tier.name;

    var subscription = tier.pricing_model === "subscription";
    var discount = subscription ? tier.yearly_discount_percent || 0 : 0;

    function show(interval) {
      if (interval === "yearly") {
        var yearCents = Math.round(tier.price_cents * 12 * (1 - discount / 100));
        amount.textContent = money(Math.round(yearCents / 12));
        per.textContent = "/ month";
        billed.textContent = money(yearCents) + " billed once a year";
        billed.hidden = false;
      } else {
        amount.textContent = money(tier.price_cents);
        per.textContent = subscription ? "/ month" : "once";
        billed.hidden = true;
      }
      if (subscription) buy.dataset.interval = interval;
      else delete buy.dataset.interval;
      toggle.querySelectorAll(".toggle__opt").forEach(function (opt) {
        var on = opt.dataset.interval === interval;
        opt.classList.toggle("is-on", on);
        opt.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    if (subscription && discount > 0) {
      toggle.hidden = false;
      setText(card, "[data-save]", "-" + discount + "%");
      toggle.addEventListener("click", function (event) {
        var opt = event.target.closest(".toggle__opt");
        if (opt) show(opt.dataset.interval);
      });
    }
    show("monthly");

    // Trials are per tier: the button only appears when this tier has one,
    // and it points at this tier so the redirect starts the right trial.
    if (tier.free_trial_enabled && tier.free_trial_days > 0) {
      trial.dataset.tierId = tier.id;
      trial.textContent = "Start a " + tier.free_trial_days + "-day trial";
      trial.hidden = false;
    }

    // Owned means "holds this tier", not just "signed in": a Free user still
    // sees the upgrade buttons. The data-yard-when attributes handle the
    // signed-out case on their own.
    if (window.yard.ownership) {
      window.yard.ownership().then(function (state) {
        if (!state || !state.owned || state.tier_id !== tier.id) return;
        var current = card.querySelector("[data-current]");
        if (current) current.hidden = false;
      }).catch(function () {});
    }
  }

  function fill(tiers) {
    var free = null;
    var pro = null;
    tiers.forEach(function (tier) {
      if (!free && tier.price_cents === 0) free = tier;
      else if (!pro && tier.price_cents > 0) pro = tier;
    });
    if (free) fillFree(plans.querySelector('[data-plan="Free"]'), free);
    if (pro) fillPro(plans.querySelector('[data-plan="Pro"]'), pro);
    if (window.yard.refresh) window.yard.refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wait);
  else wait();
})();
