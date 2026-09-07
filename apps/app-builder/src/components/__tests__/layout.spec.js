import { describe, it, expect } from 'vitest'

import { mount } from '@vue/test-utils'
import layout from '../layout.vue'

describe('layout', () => {
  it('renders properly', () => {
    const wrapper = mount(layout, {})
    expect(wrapper.text()).toContain('1')
  })
})
