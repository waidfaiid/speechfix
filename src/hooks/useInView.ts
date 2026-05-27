import { useEffect, useRef, useState, type RefObject } from 'react'

interface UseInViewOptions {
  threshold?: number
  rootMargin?: string
  triggerOnce?: boolean
  /** Scroll-Container; Standard ist der Viewport. */
  root?: RefObject<Element | null> | Element | null
}

function resolveRoot(root?: RefObject<Element | null> | Element | null): Element | null {
  if (!root) return null
  if ('current' in root) return root.current
  return root
}

export function useInView<T extends HTMLElement = HTMLDivElement>({
  threshold = 0.15,
  rootMargin = '0px 0px -8% 0px',
  triggerOnce = true,
  root,
}: UseInViewOptions = {}) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  const [rootEl, setRootEl] = useState<Element | null>(() => resolveRoot(root))

  useEffect(() => {
    setRootEl(resolveRoot(root))
  }, [root])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true)
          if (triggerOnce) observer.disconnect()
        } else if (!triggerOnce) {
          setInView(false)
        }
      },
      { threshold, rootMargin, root: rootEl },
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [threshold, rootMargin, triggerOnce, rootEl])

  return { ref, inView }
}
