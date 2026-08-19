async function loadPartial(targetSelector, partialPath) {
    const target = document.querySelector(targetSelector);
    if (!target) {
        return null;
    }
    try {
        const response = await fetch(partialPath, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Failed to fetch ${partialPath}: ${response.status}`);
        }
        const html = await response.text();
        target.innerHTML = html;
        return target;
    } catch (error) {
        console.error('Partial load error:', error);
        return null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    (async () => {
        const headerSelector = document.querySelector('#site-header') ? '#site-header' : '[data-include="partials/header.html"]';
        const headerTarget = await loadPartial(headerSelector, 'partials/header.html');
        if (headerTarget) {
            enhancePageHeader(headerTarget);
        }
    })();
    const footerSelector = document.querySelector('#site-footer') ? '#site-footer' : '[data-include="partials/footer.html"]';
    loadPartial(footerSelector, 'partials/footer.html');
});

function enhancePageHeader(container) {
    const menus = [...container.querySelectorAll('.nav-menu')];
    const closeMenus = (except = null) => {
        for (const menu of menus) {
            if (menu === except) continue;
            menu.classList.remove('is-open');
            menu.querySelector('button')?.setAttribute('aria-expanded', 'false');
        }
    };
    for (const menu of menus) {
        const trigger = menu.querySelector('button');
        trigger?.addEventListener('click', () => {
            const opening = !menu.classList.contains('is-open');
            closeMenus(menu);
            menu.classList.toggle('is-open', opening);
            trigger.setAttribute('aria-expanded', String(opening));
        });
        trigger?.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                menu.classList.remove('is-open');
                trigger.setAttribute('aria-expanded', 'false');
                trigger.focus();
            }
        });
    }
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.nav-menu')) closeMenus();
    });

    let breadcrumbs = [];
    if (container.dataset.breadcrumb) {
        try {
            breadcrumbs = JSON.parse(container.dataset.breadcrumb).map((entry) => ({
                label: (entry.label ?? '').trim(),
                href: entry.href ? entry.href.trim() : undefined,
            })).filter((entry) => entry.label);
        } catch (error) {
            console.warn('Invalid breadcrumb data:', error);
            breadcrumbs = [];
        }
    }

    const banner = container.querySelector('.site-banner');
    const breadcrumbNav = banner?.querySelector('.page-breadcrumb');
    if (!banner || !breadcrumbNav) {
        return;
    }

    breadcrumbNav.innerHTML = '';

    if (breadcrumbs.length) {
        breadcrumbs.forEach((crumb, index) => {
            if (index > 0) {
                const separator = document.createElement('span');
                separator.className = 'page-breadcrumb__separator';
                separator.textContent = '>';
                breadcrumbNav.appendChild(separator);
            }

            if (crumb.href) {
                const link = document.createElement('a');
                link.href = crumb.href;
                link.textContent = crumb.label;
                breadcrumbNav.appendChild(link);
            } else {
                const current = document.createElement('span');
                current.className = 'page-breadcrumb__current';
                current.textContent = crumb.label;
                breadcrumbNav.appendChild(current);
            }
        });
    } else {
        breadcrumbNav.remove();
    }
}
