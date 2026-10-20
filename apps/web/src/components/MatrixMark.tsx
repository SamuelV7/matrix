import type { SVGProps } from "react";

export function MatrixMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 52V12h8l16 23 16-23h8v40H46V30L32 50 18 30v22Z" fill="currentColor" />
    </svg>
  );
}
