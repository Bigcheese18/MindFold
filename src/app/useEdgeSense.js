import { useEffect, useState } from 'react'

/**
 * 隐藏式 UI 的边缘感应（**仅桌面端**）+ 两个「图钉」状态。
 *
 * 【为什么手机端必须彻底关掉这一整套】
 * 手机上根本没有鼠标，mousemove 只会由「点一下」合成出来 ——
 * 于是点屏幕左边缘会莫名其妙滑出大纲、点顶部会滑出标签栏，
 * 而这两个动作在手机上都是「误触」。更糟的是它们会和画布手势抢事件：
 * 手指从左往右平移画布，刚起步就被判定成「从边缘划入」。
 * 手机端改为**显式按钮**（左上角汉堡菜单）。
 *
 * `compact` 变化时重新绑定：转到宽屏才装回边缘感应。
 */
export function useEdgeSense(compact) {
  const [tabsOpen, setTabsOpen] = useState(false)
  const [tabsPinned, setTabsPinned] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const [treePinned, setTreePinned] = useState(false)

  useEffect(() => {
    if (compact) {
      // 切到手机端时，把边缘感应打开的浮层一并收掉，避免残留
      setTabsOpen(false)
      setTreeOpen(false)
      return
    }
    const onMove = (e) => {
      if (e.clientY <= 5) setTabsOpen(true)
      else if (e.clientY > 40 && !tabsPinned) setTabsOpen(false)

      if (e.clientX <= 5) setTreeOpen(true)
      else if (e.clientX > 275 && !treePinned) setTreeOpen(false)
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [compact, tabsPinned, treePinned])

  useEffect(() => { if (!compact && tabsPinned) setTabsOpen(true) }, [compact, tabsPinned])
  useEffect(() => { if (!compact && treePinned) setTreeOpen(true) }, [compact, treePinned])

  return {
    tabsOpen, setTabsOpen, tabsPinned, setTabsPinned,
    treeOpen, setTreeOpen, treePinned, setTreePinned,
  }
}
