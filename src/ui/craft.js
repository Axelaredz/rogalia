/* global game, dom, T, TS, Panel, ParamBar, playerStorage, Skills, util, ContainerSlot, Container */

"use strict";
class Craft {
    constructor() {
        this.visibleGroups = {};
        this.buildButton = null;
        this.selected = null;
        this.slots = [];
        this.current = null;
        this.recipes = {};

        this.availableIngredients = {};

        this.searchInput = null;
        this.searchEntity = null;
        this.filters = this.initFilters();
        this.lastSearch = playerStorage.getItem("craft.search") || "";

        this.titleElement = dom.div();
        this.ingredientsList = dom.tag("ul", "ingredients-list");

        this.recipeDetails = dom.div("#recipe-details", {text : T("Select recipe")});

        this.history = [];

        this.panel = new Panel(
            "craft",
            "Craft",
            [
                this.makeHeader(),
                dom.hr(),
                dom.tabs([
                    {
                        title: T("by skill"),
                        update: (title, contents) => {
                            dom.setContents(contents, this.makeRecipeTree(this.recipesBySkill()));
                            this.repeatSearch();
                        },
                    },
                    {
                        title: T("by purpose"),
                        update: (title, contents) => {
                            dom.setContents(contents, this.makeRecipeTree(this.recipesByPurpose()));
                            this.repeatSearch();
                        },
                    },
                    // {
                    //     title: T("favourites"),
                    //     contents: [],
                    // }
                ])
            ]
        );
        this.panel.hooks.hide = () => this.cleanUp();
        this.panel.hooks.show = () => {
            this.searchInput.focus();
            this.update();
        };

        this.blank = {
            type: null,
            entity: null,
            panel: null,
            canUse: function(entity) {
                for (var group in this.entity.Props.Ingredients) {
                    if (entity.is(group)) {
                        return true;
                    }
                }
                return false;
            },
            dwim: function(entity) {
                // TODO: handle game.controller.modifier.shift as for containers
                return this.use(entity);
            },
            use: function(entity) {
                if (this.canUse(entity)) {
                    game.network.send("build-add", {blank: this.entity.Id, id: entity.Id});
                    return true;
                }
                // do now allow using item
                return false;
            },
        };

        this.build = (e) => {
            game.controller.newCreatingCursor(
                this.blank.type,
                "build",
                () => { this.panel.show(); },
                () => { this.panel.show(); }
            );
            this.panel.hide();
        };

        this.repeatSearch();
    }

    initFilters() {
        return [
            {
                name: "craft",
                test: (type) => Entity.templates[type].MoveType == Entity.MT_PORTABLE,
            },
            {
                name: "building",
                test: (type) => Entity.templates[type].MoveType != Entity.MT_PORTABLE,
            },
            {
                name: "safe",
                test: (type) => this.safeToCreate(Entity.recipes[type]),
            },
        ].map(filter => {
            filter.enabled = playerStorage.getItem("craft.filter." + filter.name);
            return filter;
        });
    }

    repeatSearch(filter = null) {
        this.search(this.searchInput.value, true, filter);
    }

    makeHeader() {
        return dom.wrap("craft-header", [
            this.makeSearchByKeyword(),
            dom.vr(),
            this.makeSearchByIngredient(),
            dom.vr(),
            this.makeSearchFilters(),
        ]);
    }

    moveMiscRecipes(root) {
        for (const skill in root) {
            const group = root[skill];
            if (_.size(group) == 0) {
                delete root[skill];
                continue;
            }
            let misc = {};
            for (const name in group) {
                const subgroup = group[name];
                if (["portable", "lifable", "static"].includes(name) || _.size(subgroup) == 1) {
                    delete group[name];
                    _.forEach(subgroup, (recipe, type) => {
                        misc[type] = recipe;
                    });
                }
            }
            if (_.size(misc) > 0) {
                root[skill] = _.merge({misc}, group);
            }
        }
        return root;
    }

    recipesBySkill() {
        const root = _.fromPairs(Skills.list.map(skill => [skill, {}]));
        for (const [type, recipe] of Entity.sortedRecipes) {
            const group = Entity.templates[type].Group;
            const node = root[recipe.Skill][group] || {};
            node[type] = recipe;
            root[recipe.Skill][group] = node;
        }

        return this.moveMiscRecipes(root);
    }

    recipesByPurpose() {
        const root = Entity.sortedTags.reduce(function(root, [tag, entities]) {
            root[tag] = entities.reduce(function(group, entity) {
                group[entity.Type] = entity.Recipe;
                return group;
            }, {});
            return root;
        }, {});

        return this.moveMiscRecipes(root);
    }


    makeRecipeTree(root) {
        const recipeContainer = dom.wrap("recipe-container", T("Select recipe"));
        this.recipeDetails = recipeContainer;
        this.recipes = {};
        this.root = this.makeNode(root);
        return dom.wrap("recipe-tree-container", [
            dom.scrollable("recipe-tree-root", this.root).element,
            recipeContainer,
            recipeContainer,
        ]);
    }

    makeNode(tree, flat = false) {
        return dom.wrap("recipe-tree", _.map(tree, (leaf, name) => {
            if ("Ingredients" in leaf) {
                return this.makeRecipe(name, leaf);
            }

            const element = dom.wrap("recipe-subtree", [
                dom.wrap(
                    "recipe-subtree-header",
                    [
                        dom.wrap("recipe-subtree-icon"),
                        TS(name),
                    ],
                    {
                        onclick: () => {
                            element.classList.toggle("expanded");
                        },
                    }
                ),
                this.makeNode(leaf, true),
            ]);
            return element;
        }));
    }

    makeRecipe(type, recipe) {
        const name = TS(type);
        const element =  dom.wrap("recipe", name, {
            onclick: () => {
                if (game.controller.modifier.shift) {
                    game.chat.linkRecipe(type);
                    return;
                }
                if (game.player.IsAdmin && game.controller.modifier.ctrl) {
                    game.controller.newCreatingCursor(type);
                    return;
                }
                this.openRecipe({type, recipe, element});
            }
        });
        if (!this.safeToCreate(recipe)) {
            element.classList.add("unavailable");
        }
        element.dataset.type = type;
        element.dataset.search = TS(type);
        this.recipes[type] = element;
        return element;
    }

    recipe(type) {
        return Entity.recipes[type];
    }

    render(blank) {
        var ingredients = blank.Props.Ingredients;
        var type = blank.Props.Type;
        var recipe = this.recipe(type);
        // if it's an old item which no has no recipe
        if (!recipe)
            return;
        this.titleElement.textContent = TS(type);

        dom.clear(this.ingredientsList);
        var canBuild = true;
        for(var group in ingredients) {
            var has = ingredients[group];
            var required = recipe.Ingredients[group];
            var name = TS(group.replace("meta-", ""));
            var ingredient = ParamBar.makeParam(
                _.truncate(name, {length: 14}),
                {Current: has, Max: required}
            );
            ingredient.title = name;
            canBuild = canBuild && (has == required);
            this.ingredientsList.appendChild(ingredient);
        }
        this.buildButton.disabled = !canBuild;
    }

    update() {
        // update blank after server confirmation of ingredient being added
        if (this.blank.entity) {
            this.render(this.blank.entity);
        }

        if (this.current) {
            const ingredients = game.player.findItems(Object.keys(this.current.recipe.Ingredients));
            if (!_.isEqual(ingredients, this.availableIngredients)) {
                this.openRecipe(this.current);
            }
        }
    }

    open(blank, burden) {
        this.blank.entity = blank;
        var panel = this.blank.panel = new Panel("blank-panel", "Build");
        panel.entity = blank;

        var slotHelp = dom.div("", {text :  T("Drop ingredients here") + ":"});

        this.slot = dom.div();
        this.slot.classList.add("slot");
        this.slot.build = true;

        var self = this;
        var recipe = this.recipe(blank.Props.Type);
        var auto = dom.button(T("Auto"), "build-auto", function() {
            var list = [];
            var items = [];
            game.controller.iterateContainers(function(item) {
                items.push(item.entity);
            });
            for (var group in blank.Props.Ingredients) {
                var has = blank.Props.Ingredients[group];
                var required = recipe.Ingredients[group];
                var ok = true;
                while (has < required && ok) {
                    var i = items.findIndex(function(item) {
                        return item.is(group);
                    });
                    if (i != -1) {
                        list.push(items[i].Id);
                        items.splice(i, 1);
                        has++;
                    } else {
                        ok = false;
                    }
                }
            }
            if (list.length > 0)
                game.network.send("build-add", {Blank: blank.Id, List: list});
        });

        this.buildButton = dom.button(T("Build"), "build-button", function(e) {
            game.network.send("build", {id: blank.Id});
            panel.hide();
        });

        panel.setContents([
            this.titleElement,
            dom.hr(),
            slotHelp,
            this.slot,
            dom.hr(),
            this.ingredientsList,
            dom.wrap("buttons", [
                auto,
                this.buildButton,
            ]),
        ]);

        this.render(blank);
        panel.show();

        if (burden) {
            this.blank.use(burden);
        }
    }

    cleanUp() {
        this.slots.forEach(slot => slot.element.cleanUp());
        if (this.customPanel) {
            this.customPanel.close();
        }
    }

    makeList() {
        const groups = Entity.sortedRecipes.reduce(function(groups, [type, recipe]) {
            groups[recipe.Skill][type] = recipe;
            return groups;
        }, _.fromPairs(Skills.list.map(skill => [skill, {}])));

        const onclick = this.onclick.bind(this);
        const list = dom.tag("ul", "recipe-list");
        for (const group in groups) {
            const recipes = groups[group];
            const subtree = dom.tag("ul", (this.visibleGroups[group]) ? "" : "hidden");
            subtree.group = group;

            for (const type in recipes) {
                const recipe = recipes[type];
                const item = dom.tag("li", "recipe");
                item.classList.add(["portable", "liftable", "static"][Entity.templates[type].MoveType]);
                item.recipe = recipe;
                item.title = TS(type);
                item.dataset.search = item.title.toLowerCase().replace(" ", "-");
                item.textContent = item.title;
                item.type = type;
                item.onclick = onclick;
                if (this.selected && this.selected.type == item.type) {
                    item.classList.add("selected");
                    this.selected = item;
                }

                if (!this.safeToCreate(recipe))
                    item.classList.add("unavailable");

                dom.append(subtree, item);
                this.recipes[type] = item;
            }

            if (subtree.children.length == 0)
                continue;

            const subtreeLi = dom.tag("li");
            const arrow = dom.wrap("group-arrow", "+");
            const groupToggle = dom.wrap("group-toggle", [
                T(group),
                arrow,
            ]);
            const visibleGroups = this.visibleGroups;
            groupToggle.subtree = subtree;
            groupToggle.onclick = () => {
                dom.toggle(subtree);
                const hidden = subtree.classList.contains("hidden");
                arrow.textContent = (hidden) ? "+" : "‒";
                visibleGroups[subtree.group] = !hidden;
            };

            const icon = new Image();
            icon.src = "assets/icons/skills/" + group.toLowerCase() + ".png";

            dom.append(subtreeLi, [icon, groupToggle, subtree]);
            dom.append(list, subtreeLi);
        }

        if (list.children.length == 0)
            list.textContent = "You have no recipes";

        return list;
    }

    makeTree() {
        // const groups = Entity.sortedTags.reduce(function(groups, [tag, entities]) {
        //     groups[tag] = entities.reduce(function(group, entity) {
        //         group[entity.Type] = entity.Recipe;
        //         return group;
        //     }, {});
        //     return groups;
        // }, {});
    }

    makeSearchByKeyword() {
        var input = dom.tag("input");
        input.placeholder = T("search");
        input.addEventListener("keyup", (event) => this.searchHandler(event));
        input.value = this.lastSearch;
        input.classList.add("search-input");

        this.searchInput = input;

        const clear =  dom.button("×", "clear-search", () => {
            this.search();
            input.value = "";
            input.focus();
        });
        clear.title = T("Clear search");

        return dom.wrap("search-by-keyword", [
            T("Search by keyword"),
            dom.wrap("search-label", [input, clear]),
        ]);
    }

    makeSearchByIngredient() {
        return dom.wrap("search-by-ingredient", [
            this.makeSearchSlot(),
            T("Search by ingredient"),
            dom.button(T("Has\nitems"), "", () => {
                this.repeatSearch(type => this.hasIngredients(Entity.recipes[type]));
            }),
        ]);
    }

    makeSearchFilters() {
        return dom.wrap("search-filters", [
            T("Filters") + ":",
            dom.wrap(
                "filters",
                this.filters.map((filter) => {
                    const element = dom.div("search-filter", {title: T(filter.name)});
                    element.style.backgroundImage = `url(assets/icons/craft/${filter.name}.png)`;

                    if (filter.enabled)
                        element.classList.add("enabled");

                    element.onclick = () => {
                        filter.enabled = element.classList.toggle("enabled");
                        this.repeatSearch();
                    };
                    return element;

                })
            ),
        ]);
    }

    makeSearchSlot() {
        const slot = dom.wrap("slot plus");
        slot.title = T("Search by ingredient");
        slot.canUse = () => true;
        slot.use = (entity) => {
            dom.clear(slot);
            this.searchEntity = entity;
            slot.classList.remove("plus");
            slot.appendChild(entity.icon());
            this.repeatSearch();
            return true;
        };
        slot.onmousedown = () => {
            if (!game.controller.cursor.isActive()) {
                this.searchEntity = null;
                dom.clear(slot);
                slot.classList.add("plus");
                this.repeatSearch();
            }
        };

        return slot;
    }

    searchHandler(event) {
        if (event.target.value == this.lastSearch) {
            return true;
        }
        this.lastSearch = event.target.value;
        return this.search(event.target.value);
    }

    searchOrHelp(pattern) {
        var help = Craft.help[pattern];
        if (help) {
            // we need to defer panel showing because searchOrHelp will be called from click handler
            // which will focus previous panel
            _.defer(() => new Panel("craft-help", T("Help"), dom.span(help)).show());
        } else if (pattern && pattern.match(/-wall-plan$/)) {
            _.defer(() => game.controller.shop.search(pattern));
        } else {
            if (pattern in this.recipes) {
                if (this.current) {
                    this.history.push(this.current);
                }
                this.openRecipe({type: pattern, element: this.recipes[pattern]});
            } else {
                this.search(pattern, true);
            }
        }
    }

    search(pattern = "", selectMatching = false, filter = null) {
        // we do not want to show on load
        if (game.stage.name == "main") {
            this.panel.show();
        }

        const re = pattern && new RegExp(_.escapeRegExp(pattern.replace(/-/g, " ")), "i");
        const found = [];
        const traverse = (subtree) => {
            for (const child of subtree.children) {
                child.classList.remove("found");
                child.classList.remove("expanded");
                child.classList.remove("first");
                child.classList.remove("last");
                if (child.classList.contains("recipe-subtree")) {
                    traverse(child.querySelector(".recipe-tree"));
                    continue;
                }
                const type = child.dataset.type;
                let match = !filter || filter(type);
                if (match) {
                    match = this.filters.every(({test, enabled}) => !enabled || test(type));
                }
                if (match && this.selectEntity) {
                    const recipe = Entity.recipes[type];
                    match = _.some(recipe.Ingredients, (recipe, kind) => this.searchEntity.is(kind));
                }
                if (match && re) {
                    match = re.test(type) || re.test(child.dataset.search);
                }

                if (match) {
                    child.classList.add("found");
                    found.push(child);
                }
            }
        };

        traverse(this.root);

        if (!re && !this.searchEntity && !filter && this.filters.every(({enabled}) => !enabled)) {
            this.root.classList.remove("searching");
            return;
        }

        this.root.classList.add("searching");

        const value = (selectMatching) ? TS(pattern) : pattern;
        if (this.searchInput.value != value) {
            this.searchInput.value = value;
        }

        found.forEach(element => {
            if (selectMatching && (element.dataset.type == pattern || element.dataset.search == pattern)) {
                selectMatching = false;
                this.openRecipe({type: element.dataset.type, element});
            }
            let parent = element.parentNode;
            while (!parent.classList.contains("recipe-tree-root")) {
                if (parent.classList.contains("recipe-subtree")) {
                    parent.classList.add("found");
                    parent.classList.add("expanded");
                }
                parent = parent.parentNode;
            }
        });

        updateTree(this.root);

        function updateTree(subtree) {
            let last = null;
            let first = null;
            for (const child of subtree.children) {
                if (child.classList.contains("recipe") && child.classList.contains("found")) {
                    if (!first) {
                        first = child;
                    }
                    last = child;
                } else if (child.classList.contains("expanded")) {
                    last = child;
                    if (!first) {
                        first = child;
                    }
                    updateTree(child.lastChild);
                }
            }
            if (first) {
                first.classList.add("first");
            }
            if (last) {
                last.classList.add("last");
            }
        }
    }

    onclick(e) {
        if (!e.target.recipe)
            return;

        this.openRecipe(e.target, true);
    }

    openRecipe({type, recipe = Entity.recipes[type], element}) {
        if (this.current && this.current.element) {
            this.current.element.classList.remove("selected");
        }
        this.current = {type, recipe, element};
        this.cleanUp();
        element.classList.add("selected");
        const template = Entity.templates[type];
        if (template.MoveType == Entity.MT_PORTABLE)
            this.renderRecipe(this.recipeDetails);
        else
            this.renderBuildRecipe(this.recipeDetails);
    }

    renderRecipe(element) {
        this.slots = [];

        const {type, recipe} = this.current;

        this.type = this.current.type;

        this.availableIngredients = game.player.findItems(Object.keys(recipe.Ingredients));
        const canCraft = _.reduce(this.availableIngredients, (max, {length: has}, kind) => {
            const required = recipe.Ingredients[kind];
            return Math.min(max, Math.floor(has/required));
        }, +Infinity);

        const repeat = (this.repeatInput) ? this.repeatInput.value : 1;
        this.repeatInput = dom.tag("input");
        this.repeatInput.type = "number";
        this.repeatInput.min = 1;
        this.repeatInput.max = canCraft;
        this.repeatInput.value = (canCraft) ? Math.min(repeat, canCraft) : 0;

        const controlls = dom.wrap("recipe-controlls", [
            dom.make("a", "<", "less", {
                onclick: () => this.repeatInput.value = Math.max(1, this.repeatInput.value - 1)
            }),
            this.repeatInput,
            dom.make("a", ">", "more", {
                onclick: () => this.repeatInput.value = Math.min(+this.repeatInput.value + 1, canCraft)
            }),
            dom.make("a", "≫", "max", {
                onclick: () => this.repeatInput.value = canCraft
            }),
            dom.button(T("Craft"), "", () => this.craft(type, recipe, this.repeatInput.value)),
        ]);

        if (canCraft == 0) {
            controlls.classList.add("disabled");
        }

        const back = this.makeBackButton();
        if (this.history.length == 0) {
            back.disabled = true;
        }

        dom.setContents(element, [
            this.makeRecipeHeader(type, recipe),
            dom.hr(),
            this.makeIngredients(type, recipe),
            back,
            controlls,
            dom.scrollable("recipe-descr", Entity.templates[type].makeDescription()).element,
        ]);
    }

    makeIngredients(type, recipe) {
        return dom.wrap("recipe-ingredients", [
            dom.wrap("recipe-ingredients-list", _.map(recipe.Ingredients, (required, kind) => {
                const has = this.availableIngredients[kind].length;
                return dom.wrap("recipe-ingredient", [
                    required,
                    "x ",
                    this.makeLink(kind),
                    dom.span(" (" + has + ")", (has > 0) ? "available" : "unavailable", T("Available")),
                ]);
            })),
            dom.wrap("recipe-ingredients-slots", _.map(recipe.Ingredients, (required, kind) => {
                const image = Entity.getPreview(kind);
                const slot = dom.wrap("slot", image, {
                    title: TS(kind),
                    onclick: () => this.searchOrHelp(kind)
                });
                return slot;
            })),
            dom.make(
                "button",
                [
                    dom.img("assets/icons/customization.png"),
                ],
                "recipe-open-custom",
                {
                    onclick: () => this.openCustom(type, recipe),
                }
            ),
        ]);
    }

    openCustom(type, recipe) {
        this.slots = [];
        let slots = [];
        const ingredients = dom.wrap(
            "recipe-ingredients",
            _.map(recipe.Ingredients, (required, kind) => {
                const title = TS(kind);
                slots = slots.concat(_.times(required, () => {
                    const slot = new ContainerSlot({panel: this.panel, entity: {}, inspect: true}, 0);
                    const preview = _.find(Entity.templates, (tmpl) => tmpl.is(kind));
                    slot.setPlaceholder(preview.sprite.image.src, title);
                    slot.placeholder.classList.add("item-preview");

                    slot.element.check = ({entity}) => entity.is(kind);
                    slot.element.cleanUp = () => {
                        if (slot.entity) {
                            const from = Container.getEntitySlot(slot.entity);
                            from && from.unlock();
                            slot.clear();
                        }
                    };
                    slot.element.onmousedown = slot.element.cleanUp;
                    slot.element.use = (entity) => {
                        if (this.slots.some(slot => slot.entity == entity)) {
                            return false;
                        }
                        const from = Container.getEntityContainer(entity);
                        if (!from)
                            return false;

                        from.findSlot(entity).lock();
                        slot.set(entity);
                        return true;
                    };
                    slot.element.craft = true; //TODO: fix; required for controller (apply "use")

                    this.slots.push(slot);
                    return slot.element;
                }));
                return dom.wrap("recipe-ingredient", [required, "x ", this.makeLink(kind)]);
            })
        );
        const container = document.body.querySelector(".recipe-ingredients-slots");
        this.customPanel = new Panel("craft-custom-slots", TS(type), [
            T("Use this items for craft"),
            dom.hr(),
            dom.wrap(".slots-wrapper", slots),
        ]).show();
    }

    renderBuildRecipe(element) {
        const {type, recipe} = this.current;

        this.blank.type = type;
        this.availableIngredients = game.player.findItems(Object.keys(recipe.Ingredients));

        const back = this.makeBackButton();
        if (this.history.length == 0) {
            back.disabled = true;
        }

        dom.setContents(element, [
            this.makeRecipeHeader(type, recipe),
            dom.hr(),
            this.makeIngredients(type, recipe),
            back,
            dom.wrap("recipe-controlls", [
                dom.button(T("Build"), "recipe-create", () => this.build())
            ]),
            dom.scrollable("recipe-descr", Entity.templates[type].makeDescription()).element,
        ]);
    }

    makeBackButton() {
        return dom.button(T("Back"), "recipe-history-back", () => {
            this.openRecipe(this.history.pop(), true);
        });
    }

    craft(type, recipe, num) {
        // get hand added entities
        const custom = {};
        for (const {entity} of this.slots) {
            if (entity) {
                const kind = _.findKey(recipe.Ingredients, (required, kind) => entity.is(kind));
                custom[kind] = (custom[kind] || []).concat(entity.Id);
            }
        }
        const ingredients =  _.flatMap(recipe.Ingredients, (required, kind) => {
            const list = custom[kind] || [];
            const items = this.availableIngredients[kind];
            for (let i = 0; i < items.length && list.length < required; i++) {
                const {Id: id} = items[i];
                if (list.includes(id)) {
                    continue;
                }
                list.push(id);
            }
            return list;
        });
        game.network.send("craft", {type, ingredients}, () => {
            this.openRecipe(this.current);
            num--;
            if (num > 0) {
                this.repeatInput.value = Math.max(1, num);
                setTimeout(() => this.craft(type, recipe, num), 100);
            }
        });
    }

    safeToCreate(recipe) {
        if (!recipe.Lvl)
            return true;
        var skill = game.player.Skills[recipe.Skill];
        if (!skill)
            game.error("Skill not found", recipe.Skill);
        return skill.Value.Current >= recipe.Lvl;
    }

    hasIngredients(recipe) {
        const ingredients = game.player.findItems(Object.keys(recipe.Ingredients));
        return _.every(ingredients, ({length: has}, kind) => {
            const required = recipe.Ingredients[kind];
            return has >= required;
        });
    }

    makeRequirements(type, recipe) {
        return dom.wrap("recipe-requirements", [
            dom.wrap("recipe-requirements-header", T("Required") + ": "),
            dom.wrap("", [
                this.makeSkillRequirementes(recipe),
                this.makeToolRequirementes(recipe),
                this.makeEquipmentRequirementes(recipe),
                this.makeLiquidRequirementes(recipe),
            ]),
        ]);
    }

    makeSkillRequirementes(recipe) {
        if (!recipe.Skill) {
            return null;;
        }

        var safeToCreate = this.safeToCreate(recipe);

        var title = "";
        if (!safeToCreate) {
            if (recipe.IsBuilding)
                title = T("Cannot complete building");
            else
                title = T("High chance of failing");
        }

        var lvl = (recipe.Lvl > 0) ? recipe.Lvl : "";

        return dom.wrap(
            "skill-requirements" + ((safeToCreate) ? "" : " unavailable"),
            T("Skill") + " - " + T(recipe.Skill) + " " + lvl,
            {title}
        );
    }

    makeToolRequirementes(recipe) {
        return recipe.Tool && dom.wrap(
            "skill-requirementes",
            [T("Tool") + " - "].concat(this.makeLinks(recipe.Tool)),
            {title : T("Must be equipped")}
        );
    }

    makeEquipmentRequirementes(recipe) {
        return recipe.Equipment && dom.wrap(
            "equipment-requirementes",
            [T("Equipment") + " - "].concat(this.makeLinks(recipe.Equipment)),
            {title : T("You must be near equipment")}
        );
    }

    makeLiquidRequirementes(recipe) {
        return recipe.Liquid && dom.wrap(
            "liquired-requirementes",
            TS(recipe.Liquid.Type) + " : " + recipe.Liquid.Volume
        );
    }

    makeRecipeHeader(type, recipe) {
        const title = dom.span(TS(type), "recipe-title");
        title.onclick = () => {
            if (game.controller.modifier.shift) {
                game.chat.linkRecipe(type);
            }
        };
        if (recipe.Output) {
            title.textContent += ` (x${recipe.Output})`;
        }

        return dom.wrap("recipe-header", [
            dom.wrap("recipe-preview", Entity.templates[type].icon()),
            dom.wrap("recipe-title", title),
            this.makeInfo(type),
            this.makeRequirements(type, recipe),
        ]);
    };

    makeInfo(type) {
        const tmpl = Entity.templates[type];
        return dom.wrap("recipe-info", [
            tmpl.Armor && dom.wrap("", [
                T("Base armor") + ": " + tmpl.Armor
            ]),
            tmpl.Damage && dom.wrap("", [
                T("Base damage") + ": " + tmpl.Damage,
                tmpl.Ammo && dom.wrap("", T("Ammo") + ": " + T(tmpl.Ammo.Type)),
            ]),
            tmpl.EffectiveParam && tmpl.Lvl > 1 && dom.wrap(
                tmpl.nonEffective() ? "unavailable" : "",
                T(tmpl.EffectiveParam) + ": " + tmpl.Lvl
            ),
        ]);
    }

    makeLink(item) {
        if(!item) {
            return null;
        }
        var title = TS(item);
        var link = dom.link("", title, "link-item");
        link.onclick = () => {
            this.searchOrHelp(item);
        };
        return link;
    }

    makeLinks(s) {
        return (s)
            ? util.intersperse(s.split(",").map(x => this.makeLink(x)), ", ")
            : [];
    }

    dwim(slot) {
        if (!this.panel.visible) {
            return false;
        }

        if (slot.locked) {
            console.warn("dwimCraft: got locked slot");
            return false;
        }

        if (!slot.entity) {
            console.warn("dwimCraft: got empty slot");
            return false;
        }

        const entity = slot.entity;

        // skip non-empty containers
        if (entity.isContainer() && _.some(entity.Props.Slots)) {
            return false;
        }

        return this.slots.some(function(slot) {
            if (slot.entity) {
                return false;
            }
            const {check, use} = slot.element;
            return check({entity}) && use(entity);
        });
    }

    save() {
        this.filters.forEach(({name, enabled}) => {
            playerStorage.setItem("craft.filter." + name, enabled);
        });
        playerStorage.setItem("craft.search", this.searchInput.value);
    }
}
