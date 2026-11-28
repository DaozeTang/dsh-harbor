/**
 * Register the settings-section icon.
 *
 * The slot is provided by the settings shell, which may finish loading after
 * this bundle is evaluated, so the registration goes through `slots.inject`
 * rather than a one-shot `register`: the icon appears when the slot exists and
 * disappears with it. A host that has no such slot — or one that refuses the
 * registration — simply shows the section without a glyph, which is honest and
 * beats a DOM-injected icon that copies the host's markup and drifts out of
 * sync with it.
 */
export function registerSettingsNavIcon({ slots, component, onError = () => {} }) {
  try {
    return slots.inject("settings.section.icon", () => {
      try {
        return slots.register({ name: "settings.section.icon", id: "harbor-resources" }, component);
      } catch (error) {
        onError(error);
        return undefined;
      }
    });
  } catch (error) {
    onError(error);
    return () => {};
  }
}
