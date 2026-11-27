export type {
  IconComponent as LucideIcon,
  IconProps as LucideProps,
} from 'reicon-react'

import { createIcon } from 'reicon-react'

// Reicon has SidebarLeft/SidebarRight but its top/bottom variants carry a
// chevron. Same frame as SidebarLeft, with the bar at the top: a panel that
// opens down. Used by the thread Details menu.
export const PanelDown = createIcon('PanelDown', {
  O: `<path fill-rule="evenodd" clip-rule="evenodd" d="M13.7693 4.62418C15.6761 4.62418 17.0308 4.62577 18.0585 4.76394C19.0645 4.8992 19.6442 5.15287 20.0674 5.57608C20.4906 5.99929 20.7443 6.57894 20.8795 7.58503C21.0177 8.61269 21.0193 9.96738 21.0193 11.8742C21.0193 13.781 21.0177 15.1357 20.8795 16.1634C20.7443 17.1694 20.4906 17.7491 20.0674 18.1723C19.6442 18.5955 19.0645 18.8492 18.0585 18.9844C17.0308 19.1226 15.6761 19.1242 13.7693 19.1242H9.76928C7.86246 19.1242 6.5078 19.1226 5.48014 18.9844C4.47405 18.8492 3.8944 18.5955 3.47119 18.1723C3.04798 17.7491 2.79431 17.1694 2.65905 16.1634C2.52088 15.1357 2.51929 13.781 2.51929 11.8742C2.51929 9.96738 2.52088 8.61269 2.65905 7.58503C2.79431 6.57894 3.04798 5.99929 3.47119 5.57608C3.8944 5.15287 4.47405 4.89921 5.48014 4.76394C6.5078 4.62577 7.86246 4.62418 9.76928 4.62418H13.7693ZM21.1281 4.51542C20.3797 3.76706 19.4307 3.43494 18.2583 3.27732C17.1191 3.12415 15.6635 3.12416 13.8257 3.12418H9.71287C7.87511 3.12416 6.41948 3.12415 5.28027 3.27732C4.10785 3.43494 3.1589 3.76706 2.41053 4.51542C1.66217 5.26379 1.33005 6.21274 1.17243 7.38516C1.01926 8.52437 1.01927 9.97998 1.01929 11.8178V11.9306C1.01927 13.7684 1.01926 15.224 1.17243 16.3632C1.33005 17.5356 1.66217 18.4846 2.41053 19.233C3.1589 19.9813 4.10785 20.3134 5.28027 20.4711C6.41948 20.6242 7.87511 20.6242 18.2583 20.4711C19.4307 20.3134 20.3797 19.9813 21.1281 19.233C21.8764 18.4846 22.2085 17.5356 22.3662 16.3632C22.5193 15.224 22.5193 13.7684 22.5193 11.9306V11.8178C22.5193 9.97998 22.5193 8.52437 22.3662 7.38516C22.2085 6.21274 21.8764 5.26379 21.1281 4.51542Z" fill="currentColor"/><rect x="8.02" y="6.04" width="7.5" height="1.5" rx="0.75" fill="currentColor"/>`,
})

// Reicon has no plain circle; RecordCircle looks like a voicemail glyph.
export const Circle = createIcon('Circle', {
  O: `<path fill-rule="evenodd" clip-rule="evenodd" d="M12 1.25C6.06294 1.25 1.25 6.06294 1.25 12C1.25 17.9371 6.06294 22.75 12 22.75C17.9371 22.75 22.75 17.9371 22.75 12C22.75 6.06294 17.9371 1.25 12 1.25ZM2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12Z" fill="currentColor"/>`,
  F: `<circle cx="12" cy="12" r="10" fill="currentColor"/>`,
})
export { Circle as CircleIcon }

// Reicon's Loader is a ring of spokes; spun with animate-spin it looks like a
// rotating sun. A faint track with a quarter arc reads as a real spinner.
// The arc class lets App.css spin only the arc, so the track stays still.
export const Loader = createIcon('Loader', {
  O: `<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25"/><path class="reicon-spinner-arc" d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>`,
})
export { Loader as Loader2, Loader as Loader2Icon, Loader as LoaderCircle }

export {
  Activity,
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpCircle,
  Backspace,
  BellAlert,
  Bookmark,
  BranchUp,
  Bug,
  Calendar,
  Chart3,
  ChatSquareArrow,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronExpandY,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Category,
  ClipboardList,
  Clock,
  Clock3,
  Code,
  CodeFile,
  Command,
  Copy,
  Cpu,
  Download,
  Edit,
  Export,
  Eye,
  EyeOff,
  File,
  FileText,
  Flag,
  Flash,
  Flask,
  Folder,
  FolderOpen,
  FolderPlus,
  GlobalRefresh,
  Globe,
  Grid2,
  HardDrive,
  Heart,
  HelpCircle,
  Hierarchy,
  Hierarchy2,
  History,
  Home,
  Image,
  InfoCircle,
  Key,
  Keyboard,
  Layers,
  Layout,
  Lightbulb,
  Link,
  Link2,
  List,
  ListCheck,
  ListSquare,
  Lock,
  Login,
  Logout,
  Maximize,
  Maximize2,
  Menu,
  MessageCircle,
  MessagePlus,
  MessageSquare,
  Messages,
  Minimize,
  Minus,
  MinusCircle,
  Monitor,
  Moon,
  More,
  MoreH,
  Package,
  Palette,
  Paperclip,
  PauseCircle,
  Pen,
  PenLine,
  Pin,
  Play,
  Plug,
  Plus,
  Pointer,
  Puzzle,
  Radio,
  Refresh,
  RotateLeft,
  RotateRight,
  Save,
  Search,
  Send,
  Server,
  Settings,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sidebar,
  SidebarBottom,
  SidebarLeft,
  SidebarLeft2,
  SidebarRight,
  SidebarRight2,
  Siren,
  Sledgehammer,
  SortDownUp,
  Sparkles,
  Speedometer,
  Star,
  Stop,
  Sun,
  Tag,
  TerminalSquare,
  TextBlock,
  Thumbtack,
  Trash2,
  Undo,
  Upload,
  User,
  Users,
  Wand2,
  WifiOff,
  X,
  XCircle,
  XSquare,
} from 'reicon-react'

export { Download as ArrowDownToLine } from 'reicon-react'
export { Refresh as ArrowDownUp } from 'reicon-react'
export { SortDownUp as ArrowUpDown } from 'reicon-react'
export { Upload as ArrowUpToLine } from 'reicon-react'
export { Chart3 as BarChart3 } from 'reicon-react'
export { BellAlert as BellDot } from 'reicon-react'
export { TextBlock as Blocks } from 'reicon-react'
export { Bookmark as BookmarkPlus } from 'reicon-react'
export { Cpu as Bot } from 'reicon-react'
export { BrainIcon as Brain } from './BrainIcon'
export { Link as Cable } from 'reicon-react'
export { Calendar as CalendarClock } from 'reicon-react'
export { CheckCircle as CheckCircle2 } from 'reicon-react'
export { Check as CheckIcon } from 'reicon-react'
export { ChevronDown as ChevronDownIcon } from 'reicon-react'
export { ChevronLeft as ChevronLeftIcon } from 'reicon-react'
export { ChevronRight as ChevronRightIcon } from 'reicon-react'
export { ChevronUp as ChevronUpIcon } from 'reicon-react'
export { ChevronExpandY as ChevronsDownUp } from 'reicon-react'
export { ChevronExpandY as ChevronsUpDown } from 'reicon-react'
export { Loader as CircleDashed } from 'reicon-react'
export { IssueIcon as CircleDot } from './IssueIcon'
export { HelpCircle as CircleHelp } from 'reicon-react'
export { PauseCircle as CirclePause } from 'reicon-react'
export { Sidebar as Columns2 } from 'reicon-react'
export { Backspace as Delete } from 'reicon-react'
export { More as Ellipsis } from 'reicon-react'
export { Export5 as ExternalLink } from 'reicon-react'
export { CodeFile as FileCode } from 'reicon-react'
export { CodeFile as FileCode2 } from 'reicon-react'
export { File as FileIcon } from 'reicon-react'
export { CodeFile as FileJson } from 'reicon-react'
export { Flask as FlaskConical } from 'reicon-react'
export { Folder as FolderGit2 } from 'reicon-react'
export { Folder as FolderIcon } from 'reicon-react'
export { FolderConnection as FolderTree } from 'reicon-react'
export { BranchUp as GitBranch } from 'reicon-react'
export { BranchUp as GitBranchPlus } from 'reicon-react'
export { GitCommitIcon as GitCommitHorizontal } from './GitCommitIcon'
export { Hierarchy as GitFork } from 'reicon-react'
export { Hierarchy2 as GitMerge } from 'reicon-react'
export { GlobalRefresh as GitPullRequest } from 'reicon-react'
export { ChatSquareArrow as GitPullRequestArrow } from 'reicon-react'
export { GithubIcon as Github } from './GithubIcon'
export { Menu as GripVertical } from 'reicon-react'
export { Menu as GripVerticalIcon } from 'reicon-react'
export { Sledgehammer as Hammer } from 'reicon-react'
export { HardDrive as HardDriveDownload } from 'reicon-react'
export { Image as ImageIcon } from 'reicon-react'
export { Video } from 'reicon-react'
export { InfoCircle as Info } from 'reicon-react'
export { Key as KeyRound } from 'reicon-react'
export { Layout as LayoutDashboard } from 'reicon-react'
export { List3 as LayoutList } from 'reicon-react'
export { ListCheck as ListChecks } from 'reicon-react'
export { ListCheck as ListTodo } from 'reicon-react'
export { Login as LogIn } from 'reicon-react'
export { Logout as LogOut } from 'reicon-react'
export { MessagePlus as MessageSquarePlus } from 'reicon-react'
export { Messages as MessagesSquare } from 'reicon-react'
export { Minimize as Minimize2 } from 'reicon-react'
export { MoreH as MoreHorizontal } from 'reicon-react'
export { Pointer as MousePointer2 } from 'reicon-react'
export { SidebarBottom as PanelBottom } from 'reicon-react'
export { SidebarLeft as PanelLeft } from 'reicon-react'
export { SidebarLeft2 as PanelLeftClose } from 'reicon-react'
export { SidebarLeft as PanelLeftIcon } from 'reicon-react'
export { SidebarRight as PanelRight } from 'reicon-react'
export { SidebarRight2 as PanelRightClose } from 'reicon-react'
export { SidebarRight as PanelRightDashed } from 'reicon-react'
export { Pen as Pencil } from 'reicon-react'
export { Plug as PlugZap } from 'reicon-react'
export { CodeRabbitIcon as Rabbit } from './CodeRabbitIcon'
export { SentryIcon as Sentry } from './SentryIcon'
export { Refresh as RefreshCw } from 'reicon-react'
export { RotateLeft as RotateCcw } from 'reicon-react'
export { RotateRight as RotateCw } from 'reicon-react'
export { Menu as Rows3 } from 'reicon-react'
export { Search as SearchIcon } from 'reicon-react'
export { Server as ServerOff } from 'reicon-react'
export { Stop as Square } from 'reicon-react'
export { Grid2 as Table } from 'reicon-react'
export { TerminalSquare as Terminal } from 'reicon-react'
export { Undo as Undo2 } from 'reicon-react'
export { Settings as Wrench } from 'reicon-react'
export { X as XIcon } from 'reicon-react'
export { Flash as Zap } from 'reicon-react'
