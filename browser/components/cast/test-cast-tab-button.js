// Quick test button for tab casting
// Run this in the Browser Console (Ctrl+Shift+J), not Browser Toolbox

(function() {
  const { gCastService } = ChromeUtils.importESModule(
    "resource:///modules/cast/CastServiceWrapper.sys.mjs"
  );

  // Create a toolbar button
  const btn = document.createXULElement("toolbarbutton");
  btn.id = "test-cast-tab-btn";
  btn.setAttribute("label", "Cast This Tab");
  btn.setAttribute("tooltiptext", "Test tab casting to Cast device");

  btn.addEventListener("command", async () => {
    console.log("Cast Tab button clicked");

    try {
      // Get the current browser and window
      const browser = gBrowser.selectedBrowser;
      const win = window;

      console.log("Starting tab cast...");
      const result = await gCastService.startTabCasting(
        "manual-10.0.0.122",
        browser,
        win,
        { fps: 10, quality: 0.8 }
      );

      console.log("Tab casting started:", result);
    } catch (error) {
      console.error("Failed to start tab casting:", error);
    }
  });

  // Add to nav-bar
  const navbar = document.getElementById("nav-bar");
  if (navbar) {
    navbar.appendChild(btn);
    console.log("Cast Tab button added to toolbar!");
  } else {
    console.error("Could not find nav-bar");
  }
})();
