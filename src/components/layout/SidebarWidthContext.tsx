import { createContext, useContext } from 'react'

// Default width matches the default in ui-store
const SidebarWidthContext = createContext<number>(250)

export const SidebarWidthProvider = SidebarWidthContext.Provider
// eslint-disable-next-line react-refresh/only-export-components
export const useSidebarWidth = () => useContext(SidebarWidthContext)
