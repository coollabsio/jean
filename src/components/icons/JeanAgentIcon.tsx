import type { SVGProps } from 'react'

/** Pixel-art Jean coordinator: a smiling face with a boss crown. */
export function JeanAgentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      {...props}
    >
      {/* Crown */}
      <path fill="#F59E0B" d="M3 1h1v1h1v1h2V1h2v2h2V2h1V1h1v3H3z" />
      {/* Shadow */}
      <path fill="#7A6531" d="M14 5h1v10H3v-1h11z" />
      {/* Head */}
      <rect x="2" y="4" width="12" height="10" fill="#FDD24F" />
      {/* Eyes */}
      <path fill="#3F3416" d="M5 7h1v2H5zM10 7h1v2h-1z" />
      {/* Cheeks */}
      <path fill="#F59E9E" d="M3 10h2v1H3zM11 10h2v1h-2z" />
      {/* Smile */}
      <path fill="#3F3416" d="M6 10h1v1H6zM9 10h1v1H9zM7 11h2v1H7z" />
    </svg>
  )
}
