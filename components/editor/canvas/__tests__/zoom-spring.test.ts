import { describe, expect, it } from "vitest"

import {
  SpringMassDamperSimulation,
  ZOOM_FOCUS_SPRING_CONFIG,
  snapToEdges,
  springEase,
  springEaseOut,
} from "../pixi/zoom-spring"

describe("springEase / springEaseOut", () => {
  it("pins the endpoints", () => {
    expect(springEase(0)).toBe(0)
    expect(springEase(1)).toBe(1)
    expect(springEaseOut(0)).toBe(0)
    expect(springEaseOut(1)).toBe(1)
  })

  it("rises (front-loaded) toward 1 with at most a tiny terminal overshoot", () => {
    let prev = 0
    let dips = 0
    for (let t = 0.05; t <= 1; t += 0.05) {
      const v = springEase(t)
      if (v < prev - 1e-6) dips++
      prev = v
    }
    expect(dips).toBeLessThanOrEqual(1)
    // Front-loaded: well past halfway by the midpoint of the ramp.
    expect(springEase(0.5)).toBeGreaterThan(0.5)
  })

  it("zoom-out is overshoot-free (never exceeds 1)", () => {
    for (let t = 0; t <= 1; t += 0.02) {
      expect(springEaseOut(t)).toBeLessThanOrEqual(1 + 1e-9)
    }
  })
})

describe("SpringMassDamperSimulation", () => {
  it("settles to its target over time", () => {
    const sim = new SpringMassDamperSimulation(ZOOM_FOCUS_SPRING_CONFIG)
    sim.setPosition({ x: 0, y: 0 })
    sim.setTarget({ x: 1, y: 0 })
    for (let i = 0; i < 400; i++) sim.run(8)
    expect(sim.position.x).toBeCloseTo(1, 2)
    expect(sim.position.y).toBeCloseTo(0, 2)
  })

  it("lags a moving target — it eases in, never teleports", () => {
    const sim = new SpringMassDamperSimulation(ZOOM_FOCUS_SPRING_CONFIG)
    sim.setPosition({ x: 0, y: 0 })
    sim.setTarget({ x: 1, y: 0 })
    sim.run(8)
    expect(sim.position.x).toBeGreaterThan(0)
    expect(sim.position.x).toBeLessThan(1)
  })
})

describe("snapToEdges", () => {
  it("passes the centre band through and pins focus inside the dead-zone to the edge", () => {
    expect(snapToEdges(0.5, 0.25)).toBeCloseTo(0.5, 3)
    expect(snapToEdges(0.1, 0.25)).toBe(0)
    expect(snapToEdges(0.95, 0.25)).toBe(1)
  })

  it("is a no-op when snapRatio is 0", () => {
    expect(snapToEdges(0.3, 0)).toBe(0.3)
  })
})
