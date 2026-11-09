import { DialogBody, DialogFooter, DialogHeader, DialogPopup } from "./dialog";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";
import { Button } from "./button";
import { test } from "node:test";
import { Input } from "./input";
import { Form } from "./form";

test("sectioned dialogs leave scrolling and padding to the body", () => {
	const popup = DialogPopup({ layout: "sectioned", borderRadius: 12 });
	assert.equal(typeof popup.props.className, "string");
	assert.match(popup.props.className, /overflow-hidden/u);
	assert.match(popup.props.className, /\bp-0\b/u);
	assert.match(popup.props.className, /\bgap-0\b/u);
	assert.doesNotMatch(
		popup.props.className,
		/overflow-auto|\bp-6\b|\bgap-6\b/u,
	);
	assert.equal(popup.props.layout, undefined);
	assert.equal(popup.props.style.borderRadius, 12);
	const defaultPopup = DialogPopup({});
	assert.match(defaultPopup.props.className, /overflow-auto/u);
	assert.match(defaultPopup.props.className, /\bp-6\b/u);
});

test("dialog sections keep footer outside the scroll region but inside the form", () => {
	const html = renderToStaticMarkup(
		<>
			<DialogHeader>Header</DialogHeader>
			<Form className="flex min-h-0 flex-1 flex-col">
				<DialogBody>
					<Input aria-label="Name" name="name" required />
				</DialogBody>
				<DialogFooter>
					<Button type="submit">Save</Button>
				</DialogFooter>
			</Form>
		</>,
	);
	assert.match(
		html,
		/<div(?=[^>]*data-slot="dialog-header")(?=[^>]*class="[^"]*shrink-0)[^>]*>/u,
	);
	assert.match(
		html,
		/<div(?=[^>]*data-slot="dialog-body")(?=[^>]*class="[^"]*min-h-0)(?=[^>]*class="[^"]*overflow-y-auto)(?=[^>]*class="[^"]*[\s"]scroll-p-6[\s"])(?=[^>]*class="[^"]*[\s"]p-6[\s"])[^>]*>/u,
	);
	assert.match(html, /<input[^>]*name="name"/u);
	assert.match(
		html,
		/<\/div><\/div><div(?=[^>]*data-slot="dialog-footer")[^>]*>/u,
	);
	assert.match(
		html,
		/<div(?=[^>]*data-slot="dialog-footer")(?=[^>]*class="[^"]*shrink-0)(?=[^>]*class="[^"]*flex-wrap)[^>]*>/u,
	);
	assert.match(
		html,
		/<button[^>]*type="submit"[^>]*>Save<\/button><\/div><\/form>/u,
	);
});
