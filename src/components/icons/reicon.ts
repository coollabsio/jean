export type {
  IconComponent as LucideIcon,
  IconProps as LucideProps,
} from 'reicon-react'

import { createIcon } from 'reicon-react'

// Reicon has no plain circle; RecordCircle looks like a voicemail glyph.
export const Circle = createIcon('Circle', {
  O: `<path fill-rule="evenodd" clip-rule="evenodd" d="M12 1.25C6.06294 1.25 1.25 6.06294 1.25 12C1.25 17.9371 6.06294 22.75 12 22.75C17.9371 22.75 22.75 17.9371 22.75 12C22.75 6.06294 17.9371 1.25 12 1.25ZM2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12C21.25 17.1086 17.1086 21.25 12 21.25C6.89137 21.25 2.75 17.1086 2.75 12Z" fill="currentColor"/>`,
  F: `<circle cx="12" cy="12" r="10" fill="currentColor"/>`,
})
export { Circle as CircleIcon }

export {
  Activity,
  AlertCircle,
  AlertTriangle,
  Archive,
  ArchiveDown,
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
  Loader,
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
  Users,
  Wand2,
  WifiOff,
  X,
  XCircle,
  XSquare,
} from 'reicon-react'

export { ArchiveDown as ArchiveRestore } from 'reicon-react'
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
export { Loader as Loader2 } from 'reicon-react'
export { Loader as Loader2Icon } from 'reicon-react'
export { Loader as LoaderCircle } from 'reicon-react'
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
