import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// text-2xs is a custom font size (App.css); without this, twMerge treats it as
// a text color and drops the real color class.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['2xs'] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
