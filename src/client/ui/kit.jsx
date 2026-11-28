/**
 * Harbor UI kit — the workbench's own primitives.
 *
 * These are deliberately small and dependency-free: a plugin shares a document
 * with DeepSeek Harness and cannot rely on the host's internal component
 * package, so the kit reproduces the host's metrics (32px controls, 12px
 * radii, 13px type, one shared focus ring) on top of the host's semantic
 * tokens. Behaviour that the browser does not give for free — modal focus
 * containment, anchored menus, toasts — lives here once instead of in every
 * screen.
 *
 * Standing rules for every screen:
 * - never write a colour, radius or font literal; use the tokens in app.css;
 * - one primary action per surface, everything else is secondary or ghost;
 * - a surface always renders one of: content, empty state, error note, or a
 *   disabled control that explains itself.
 */

// Each component lives with its own kind; this file is the stable entry point
// so every consumer keeps importing "./ui/kit.jsx".
export {
  Button,
  Checkbox,
  Field,
  Icon,
  IconButton,
  InputGroup,
  SegmentedControl,
  Select,
  Switch,
  Tabs,
  TextArea,
  TextInput,
  cx,
} from "./kit/primitives.jsx";
export {
  Badge,
  Card,
  Dot,
  EmptyState,
  ErrorNote,
  Notice,
  Pill,
  ProgressBar,
  Row,
  Section,
  Spinner,
} from "./kit/surfaces.jsx";
export {
  ConfirmHost,
  Dialog,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  ToastHost,
  confirmAction,
  toast,
  useCopy,
} from "./kit/overlays.jsx";
